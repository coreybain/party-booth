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

  it("keeps the plain-text part as a standalone message, not a stub", () => {
    // The console sender only ever prints `text`, and a watch or screen reader
    // may only ever read it. It has to work with the HTML thrown away.
    const message = cohostInviteEmail({
      eventName: "Corey's birthday",
      invitedByName: "Corey",
      joinUrl: "https://partybooth.test/e/1",
    });
    expect(message.text).not.toContain("<");
    expect(message.text).toContain("Corey's birthday");
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

/* -------------------------------------------------------------------------- */

/**
 * HTML bodies.
 *
 * Asserted by behaviour, not by shape: no snapshots, because the point of these
 * tests is that the copy and the styling stay free to move while the guarantees
 * — the code is there, the link is there, nothing user-supplied is executable —
 * do not.
 */
describe("HTML templates", () => {
  const HTML_MESSAGES = () => [
    otpEmail({ code: "482913", purpose: "guestSignIn" }),
    organiserInviteEmail({
      inviteUrl: "https://partybooth.test/invite/organiser/abc",
      invitedByName: "Corey",
      note: "You're up",
      expiresInDays: 7,
    }),
    cohostInviteEmail({
      eventName: "Corey's birthday",
      invitedByName: "Corey",
      joinUrl: "https://partybooth.test/invite/xyz",
    }),
  ];

  /** Every `href` in the document, unescaped. */
  function hrefs(html: string): string[] {
    return [...html.matchAll(/href="([^"]*)"/g)].map((match) =>
      (match[1] ?? "").replace(/&amp;/g, "&"),
    );
  }

  it("gives every template an HTML alternative alongside the text one", () => {
    for (const message of HTML_MESSAGES()) {
      expect(message.html, message.subject).toBeTruthy();
      expect(message.html).toMatch(/^<!doctype html>/i);
      expect(message.text.length).toBeGreaterThan(0);
    }
  });

  it("lays out with tables and inline styles, inside a 600px shell", () => {
    for (const message of HTML_MESSAGES()) {
      const html = message.html ?? "";
      // Presentational tables must be hidden from screen readers.
      expect(html).toContain('role="presentation"');
      expect(html.match(/<table/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(html.match(/<table(?![^>]*role="presentation")/g)).toBeNull();
      expect(html).toContain("max-width:600px");
      expect(html).toContain("@media only screen and (max-width:620px)");
    }
  });

  it("depends on nothing the inbox has to fetch or run", () => {
    for (const message of HTML_MESSAGES()) {
      const html = message.html ?? "";
      for (const forbidden of ["<script", "<img", "<svg", "<link", "@import", "url(", "<iframe"]) {
        expect(html.toLowerCase(), forbidden).not.toContain(forbidden);
      }
      // Only our own links may leave the document.
      for (const href of hrefs(html)) expect(href).toMatch(/^https:\/\/partybooth\.test\//);
    }
  });

  it("declares a dark colour scheme and paints the brand tokens inline", () => {
    for (const message of HTML_MESSAGES()) {
      const html = message.html ?? "";
      // Without this, clients invert an already-dark design into light-on-light.
      expect(html).toContain('<meta name="color-scheme" content="dark" />');
      expect(html).toContain("color-scheme:dark");
      expect(html).toContain("#0a0a0f"); // canvas
      expect(html).toContain("#14141d"); // surface
      expect(html).toContain("#f5f3f8"); // ink
      expect(html).toContain("#ff4d8d"); // accent
      // Backgrounds are also set as attributes, for clients that drop <style>.
      expect(html).toContain('bgcolor="#0a0a0f"');
      // Outlook.com rewrites colours; these hooks put them back.
      expect(html).toContain("[data-ogsc]");
    }
  });

  it("leads with hidden preheader text so the inbox preview is useful", () => {
    const otp = otpEmail({ code: "482913", purpose: "guestSignIn" }).html ?? "";
    const preheader = /<div style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(otp)?.[1] ?? "";
    expect(preheader).toContain("482913");
    expect(otp.indexOf(preheader)).toBeLessThan(otp.indexOf("<table"));

    const invite =
      cohostInviteEmail({
        eventName: "Corey's birthday",
        invitedByName: "Corey",
        joinUrl: "https://partybooth.test/e/1",
      }).html ?? "";
    expect(/<div style="display:none;[^"]*">([\s\S]*?)<\/div>/.exec(invite)?.[1]).toContain(
      "co-host",
    );
  });

  it("makes the OTP the dominant element, in one selectable piece", () => {
    const minutes = Math.round(OTP_POLICY.ttlMs / 60_000);
    const html = otpEmail({ code: "482913", purpose: "organiserSignIn" }).html ?? "";
    // One run of digits — not split into per-character cells, which would make
    // it uncopyable on a phone.
    expect(html).toContain(">482913<");
    const codeStyle = /<div class="pb-code[^"]*" style="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(codeStyle).toMatch(/font-size:(3\d|[4-9]\d)px/);
    expect(codeStyle).toContain("letter-spacing");
    expect(html).toContain(`${minutes} minutes`);
    expect(html).toMatch(/didn&#39;t ask/i);
  });

  it("gives each invitation a described CTA and a visible fallback URL", () => {
    const invites = [
      {
        html: organiserInviteEmail({
          inviteUrl: "https://partybooth.test/invite/organiser/abc",
          invitedByName: "Corey",
          expiresInDays: 7,
        }).html,
        url: "https://partybooth.test/invite/organiser/abc",
      },
      {
        html: cohostInviteEmail({
          eventName: "Corey's birthday",
          invitedByName: "Corey",
          joinUrl: "https://partybooth.test/invite/xyz",
        }).html,
        url: "https://partybooth.test/invite/xyz",
      },
    ];

    for (const { html, url } of invites) {
      const body = html ?? "";
      // Linked twice: once from the button, once from the pasteable fallback.
      expect(hrefs(body).filter((href) => href === url)).toHaveLength(2);
      expect(body).toContain(`>${url}<`);
      // The label has to stand on its own — no "click here", no colour-only cue.
      const labels = [...body.matchAll(/<a href="[^"]*"[^>]*>([^<]*)<\/a>/g)].map(
        (m) => m[1] ?? "",
      );
      expect(labels.some((label) => /^(Accept the invitation|Open the event)$/.test(label))).toBe(
        true,
      );
    }
  });

  it("carries the inviter, the event and the note into the HTML too", () => {
    const organiser = organiserInviteEmail({
      inviteUrl: "https://partybooth.test/invite/organiser/abc",
      invitedByName: "Corey",
      note: "You're up",
      expiresInDays: 7,
    });
    expect(organiser.html).toContain("Corey");
    expect(organiser.html).toContain("You&#39;re up");
    expect(organiser.html).toContain("7 days");

    const cohost = cohostInviteEmail({
      eventName: "Corey's birthday",
      invitedByName: "Corey",
      joinUrl: "https://partybooth.test/e/1",
    });
    expect(cohost.html).toContain("Corey&#39;s birthday");
  });

  it("omits the note entirely when there isn't one", () => {
    const html =
      organiserInviteEmail({
        inviteUrl: "https://partybooth.test/invite/organiser/abc",
        invitedByName: "Corey",
        expiresInDays: 7,
      }).html ?? "";
    expect(html).not.toContain("font-style:italic");
  });

  it("escapes user-supplied names, events and notes", () => {
    const attack = '<script>alert("x")</script>';
    const html =
      cohostInviteEmail({
        eventName: attack,
        invitedByName: attack,
        joinUrl: "https://partybooth.test/e/1",
      }).html ?? "";
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&quot;x&quot;");

    // A note is the one multi-line field, and the one most likely to be pasted
    // in from somewhere else.
    const note =
      organiserInviteEmail({
        inviteUrl: "https://partybooth.test/invite/organiser/abc",
        invitedByName: "Corey",
        note: '</p><img src=x onerror="alert(1)">',
        expiresInDays: 7,
      }).html ?? "";
    expect(note).not.toContain("<img");
    expect(note).not.toContain('onerror="');
    expect(note).toContain("&lt;img");
  });

  it("never turns a non-http URL into a link", () => {
    const hostile = [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      'https://partybooth.test/" onclick="alert(1)',
    ];

    for (const url of hostile) {
      const html =
        cohostInviteEmail({ eventName: "Party", invitedByName: "Corey", joinUrl: url }).html ?? "";
      // No href at all rather than a `javascript:` one, and no attribute that
      // could have been closed early and reopened.
      expect(hrefs(html)).toHaveLength(0);
      expect(html.toLowerCase()).not.toContain('href="javascript:');
      expect(html.toLowerCase()).not.toContain('onclick="');
      // Still shown, so the recipient can see what they were sent — just inert.
      expect(html).toContain(escapeForTest(url));
    }
  });

  it("keeps a note's line breaks without letting it inject markup", () => {
    const html =
      organiserInviteEmail({
        inviteUrl: "https://partybooth.test/invite/organiser/abc",
        invitedByName: "Corey",
        note: "Line one\nLine two",
        expiresInDays: 7,
      }).html ?? "";
    expect(html).toContain("Line one<br />Line two");
  });
});

/** The same escaping the templates apply, restated so the test is independent. */
function escapeForTest(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
