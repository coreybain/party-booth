import { OTP_POLICY } from "@partybooth/contracts";
import { resetEnvCache } from "@partybooth/env";
import { serverEnv } from "@partybooth/env/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ConsoleEmailSender } from "./console";
import { getEmailSender, sendEmail, setEmailSender } from "./index";
import { ResendEmailSender } from "./resend";
import { cohostInviteEmail, organiserInviteEmail, otpEmail } from "./templates";
import type { EmailMessage, EmailSender } from "./types";

const MESSAGE: EmailMessage = {
  to: "guest@partybooth.test",
  subject: "Test",
  text: "Body line one\nBody line two",
};

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetEnvCache(serverEnv);
}

afterEach(() => {
  setEmailSender(undefined);
  setEnv({
    RESEND_API_KEY: undefined,
    RESEND_FROM_EMAIL: undefined,
    NODE_ENV: undefined,
    DEPLOYMENT_ENVIRONMENT: undefined,
    EMAIL_DEBUG_LOG_CODES: undefined,
  });
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("provider selection", () => {
  it("falls back to the console when Resend is not configured", () => {
    setEnv({ RESEND_API_KEY: undefined, RESEND_FROM_EMAIL: undefined });
    expect(getEmailSender().id).toBe("console");
  });

  it("uses Resend once both variables are present", () => {
    setEnv({ RESEND_API_KEY: "re_test_key", RESEND_FROM_EMAIL: "hello@partybooth.test" });
    expect(getEmailSender().id).toBe("resend");
  });

  it("stays on the console when only half the configuration is there", () => {
    // A key with no verified from-address would fail on every send; better to
    // keep printing to the log than to look configured and silently bounce.
    setEnv({ RESEND_API_KEY: "re_test_key", RESEND_FROM_EMAIL: undefined });
    expect(getEmailSender().id).toBe("console");
  });
});

describe("ConsoleEmailSender", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("reports success so the sign-in flow completes with no credentials", async () => {
    const result = await new ConsoleEmailSender().send(MESSAGE);
    expect(result).toEqual({ ok: true, provider: "console" });
  });

  it("withholds the body by default — a logged OTP is a sign-in credential", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new ConsoleEmailSender().send({ ...MESSAGE, text: "Your code is 482913" });
    const printed = warn.mock.calls.flat().join("\n");
    expect(printed).not.toContain("482913");
    expect(printed).toContain("guest@partybooth.test");
    expect(printed).toContain("EMAIL_DEBUG_LOG_CODES");
  });

  it("prints the body only when explicitly asked to", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await new ConsoleEmailSender({ logBody: true }).send({
      ...MESSAGE,
      text: "Your code is 482913",
    });
    expect(warn.mock.calls.flat().join("\n")).toContain("482913");
  });

  it("refuses rather than faking a success outside development", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const result = await new ConsoleEmailSender({ refuse: true }).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, provider: "console", retryable: false });
    expect(error.mock.calls.flat().join("\n")).toMatch(/never delivered/i);
  });

  it("never prints the body when it is refusing, whatever the flag says", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await new ConsoleEmailSender({ refuse: true }).send({
      ...MESSAGE,
      text: "Your code is 482913",
    });
    expect(error.mock.calls.flat().join("\n")).not.toContain("482913");
  });
});

describe("console sender selection", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("fails closed on a production deployment with no Resend credentials", async () => {
    setEnv({ DEPLOYMENT_ENVIRONMENT: "production" });
    const result = await getEmailSender().send(MESSAGE);
    expect(result).toMatchObject({ ok: false, retryable: false });
  });

  it("fails closed on preview too — only development is allowed to pretend", async () => {
    setEnv({ DEPLOYMENT_ENVIRONMENT: "preview" });
    expect((await getEmailSender().send(MESSAGE)).ok).toBe(false);
  });

  it("still completes sign-in on a development deployment", async () => {
    setEnv({ DEPLOYMENT_ENVIRONMENT: "development" });
    expect((await getEmailSender().send(MESSAGE)).ok).toBe(true);
  });

  it("ignores EMAIL_DEBUG_LOG_CODES outside development", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    setEnv({ DEPLOYMENT_ENVIRONMENT: "production", EMAIL_DEBUG_LOG_CODES: "1" });
    await getEmailSender().send({ ...MESSAGE, text: "Your code is 482913" });
    expect(error.mock.calls.flat().join("\n")).not.toContain("482913");
  });

  it("prints the code in development once opted in, so the flow is testable offline", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    setEnv({ DEPLOYMENT_ENVIRONMENT: "development", EMAIL_DEBUG_LOG_CODES: "1" });
    await getEmailSender().send({ ...MESSAGE, text: "Your code is 482913" });
    expect(warn.mock.calls.flat().join("\n")).toContain("482913");
  });
});

describe("ResendEmailSender", () => {
  function senderWith(fetchImpl: typeof fetch): ResendEmailSender {
    return new ResendEmailSender({
      apiKey: "re_test_key",
      from: { email: "hello@partybooth.test", name: "PartyBooth" },
      fetchImpl,
    });
  }

  it("posts the message and returns the provider id", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_1" }), { status: 200 }),
    ) as unknown as typeof fetch;

    const result = await senderWith(fetchImpl).send(MESSAGE);

    expect(result).toEqual({ ok: true, provider: "resend", messageId: "msg_1" });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>)["authorization"]).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body["from"]).toBe("PartyBooth <hello@partybooth.test>");
    expect(body["to"]).toEqual(["guest@partybooth.test"]);
    expect(body["text"]).toBe(MESSAGE.text);
  });

  it("sends a bare address when no display name is configured", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    await new ResendEmailSender({
      apiKey: "re_test_key",
      from: { email: "hello@partybooth.test" },
      fetchImpl,
    }).send(MESSAGE);
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)["from"]).toBe("hello@partybooth.test");
  });

  it("maps tags into Resend's name/value shape", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    await senderWith(fetchImpl).send({ ...MESSAGE, tags: { kind: "otp" } });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(JSON.parse(init.body as string)["tags"]).toEqual([{ name: "kind", value: "otp" }]);
  });

  it("treats a 4xx as permanent — an unverified domain will not fix itself", async () => {
    const fetchImpl = (async () =>
      new Response("domain not verified", { status: 403 })) as typeof fetch;
    const result = await senderWith(fetchImpl).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, retryable: false });
    expect(result.ok === false && result.error).toContain("403");
  });

  it("treats 429 and 5xx as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const fetchImpl = (async () => new Response("", { status })) as typeof fetch;
      const result = await senderWith(fetchImpl).send(MESSAGE);
      expect(result, `status ${status}`).toMatchObject({ ok: false, retryable: true });
    }
  });

  it("does not throw when the network is down", async () => {
    const fetchImpl = (async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await senderWith(fetchImpl).send(MESSAGE);
    expect(result).toMatchObject({ ok: false, retryable: true });
  });
});

describe("sendEmail", () => {
  it("never throws, even if the sender does", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const exploding: EmailSender = {
      id: "resend",
      send: () => Promise.reject(new Error("boom")),
    };
    setEmailSender(exploding);

    const result = await sendEmail(MESSAGE);
    expect(result).toMatchObject({ ok: false, provider: "resend", error: "boom" });
  });

  it("routes through the installed sender", async () => {
    const sent: EmailMessage[] = [];
    setEmailSender({
      id: "console",
      send: (message) => {
        sent.push(message);
        return Promise.resolve({ ok: true as const, provider: "console" as const });
      },
    });

    await sendEmail(MESSAGE);
    expect(sent).toEqual([MESSAGE]);
  });
});

describe("templates", () => {
  it("puts the OTP in the subject, where a phone shows it in the notification", () => {
    const message = otpEmail({ code: "482913", purpose: "organiserSignIn" });
    expect(message.subject).toContain("482913");
    expect(message.text).toContain("482913");
  });

  it("states the real expiry from the shared policy", () => {
    const minutes = Math.round(OTP_POLICY.ttlMs / 60_000);
    expect(otpEmail({ code: "482913", purpose: "guestSignIn" }).text).toContain(
      `${minutes} minutes`,
    );
  });

  it("uses different copy for admin, organiser and guest sign-ins", () => {
    const subjects = (["adminSignIn", "organiserSignIn", "guestSignIn"] as const).map(
      (purpose) => otpEmail({ code: "482913", purpose }).subject,
    );
    expect(new Set(subjects).size).toBe(3);
  });

  it("reassures someone who did not request a code", () => {
    expect(otpEmail({ code: "482913", purpose: "guestSignIn" }).text).toMatch(/didn't ask/i);
  });

  it("includes the link and expiry in an organiser invitation", () => {
    const message = organiserInviteEmail({
      inviteUrl: "https://partybooth.test/invite/abc",
      invitedByName: "Corey",
      note: "You're up",
      expiresInDays: 7,
    });
    expect(message.text).toContain("https://partybooth.test/invite/abc");
    expect(message.text).toContain("Corey");
    expect(message.text).toContain("You're up");
    expect(message.text).toContain("7 days");
  });

  it("names the event in a co-host invitation", () => {
    const message = cohostInviteEmail({
      eventName: "Corey's birthday",
      invitedByName: "Corey",
      joinUrl: "https://partybooth.test/e/1",
    });
    expect(message.subject).toContain("Corey's birthday");
    expect(message.text).toContain("https://partybooth.test/e/1");
  });

  it("tags every message for deliverability triage, with no PII", () => {
    const messages = [
      otpEmail({ code: "482913", purpose: "guestSignIn" }),
      organiserInviteEmail({ inviteUrl: "u", invitedByName: "C", expiresInDays: 7 }),
      cohostInviteEmail({ eventName: "e", invitedByName: "C", joinUrl: "u" }),
    ];
    for (const message of messages) {
      expect(message.tags?.["kind"]).toBeTruthy();
      expect(JSON.stringify(message.tags)).not.toContain("@");
    }
  });
});
