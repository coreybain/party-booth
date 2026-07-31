import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ReactNode } from "react";

const fake = vi.hoisted(() => ({
  sendVerificationOtp: vi.fn(),
  emailOtp: vi.fn(),
  replace: vi.fn(),
}));

const authClient = {
  emailOtp: { sendVerificationOtp: fake.sendVerificationOtp },
  signIn: { emailOtp: fake.emailOtp },
};

vi.mock("@/providers", () => ({ useAuthClient: () => authClient }));
vi.mock("@/providers/session", () => ({
  useSession: () => ({ state: { status: "signed-out" } }),
}));
vi.mock("@/lib/auth-client", () => ({
  signInWithApple: vi.fn(),
  signInWithGoogle: vi.fn(),
}));
vi.mock("@/lib/sentry", () => ({ captureHandledError: vi.fn() }));
vi.mock("expo-router", () => ({
  Redirect: ({ href }: { href: string }) => createElement("span", null, `redirect:${href}`),
  useRouter: () => ({ replace: fake.replace }),
}));
vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: (props: { children?: ReactNode }) =>
    createElement("div", null, props.children as ReactNode),
}));

beforeEach(() => {
  fake.sendVerificationOtp.mockReset().mockResolvedValue({ error: null });
  fake.emailOtp.mockReset().mockResolvedValue({ error: null });
  fake.replace.mockReset();
});

async function renderSignIn() {
  const { default: SignInScreen } = await import("../../app/(auth)/sign-in");
  return render(createElement(SignInScreen));
}

describe("mobile email-code sign-in", () => {
  it("requests and verifies a code through Better Auth, then resumes the entry gate", async () => {
    await renderSignIn();

    fireEvent.click(screen.getByLabelText("Continue with email"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: " Reviewer@Example.com " },
    });
    fireEvent.click(screen.getByLabelText("Email me a code"));

    await waitFor(() => {
      expect(fake.sendVerificationOtp).toHaveBeenCalledWith({
        email: "reviewer@example.com",
        type: "sign-in",
      });
    });
    fireEvent.change(screen.getByLabelText("Six-digit email code"), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByLabelText("Verify and sign in"));

    await waitFor(() => {
      expect(fake.emailOtp).toHaveBeenCalledWith({
        email: "reviewer@example.com",
        otp: "123456",
      });
      expect(fake.replace).toHaveBeenCalledWith("/");
    });
  });

  it("does not submit an invalid address", async () => {
    await renderSignIn();
    fireEvent.click(screen.getByLabelText("Continue with email"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "not-an-email" },
    });
    fireEvent.blur(screen.getByLabelText("Email address"));

    expect(screen.getByLabelText("Email me a code").getAttribute("aria-disabled")).toBe("true");
    expect(fake.sendVerificationOtp).not.toHaveBeenCalled();
  });

  it("shows a structured Better Auth failure and stays on the code step", async () => {
    fake.emailOtp.mockResolvedValue({ error: { code: "INVALID_OTP" } });
    await renderSignIn();
    fireEvent.click(screen.getByLabelText("Continue with email"));
    fireEvent.change(screen.getByLabelText("Email address"), {
      target: { value: "reviewer@example.com" },
    });
    fireEvent.click(screen.getByLabelText("Email me a code"));
    await screen.findByLabelText("Six-digit email code");
    fireEvent.change(screen.getByLabelText("Six-digit email code"), {
      target: { value: "000000" },
    });
    fireEvent.click(screen.getByLabelText("Verify and sign in"));

    expect(await screen.findByText(/code was not right/i)).toBeTruthy();
    expect(screen.getByLabelText("Six-digit email code")).toBeTruthy();
    expect(fake.replace).not.toHaveBeenCalled();
  });
});
