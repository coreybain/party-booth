"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useCallback, useEffect, useState } from "react";

import { BackendNotConfigured } from "@/components/backend-not-configured";
import { Callout } from "@/components/ui/callout";
import { Button } from "@/components/ui/button";
import { CodeField } from "@/components/ui/code-field";
import { TextField } from "@/components/ui/text-field";
import { authClient } from "@/lib/auth-client";
import { isBackendConfigured } from "@/lib/backend";
import { cn } from "@/lib/cn";
import {
  OTP_EXPIRY_MINUTES,
  OTP_LENGTH,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
} from "@/lib/contracts";
import { authErrorMessage, formatCooldown, isProbablyEmail, normaliseEmail } from "@/lib/otp";

export type OtpAudience = "organiser" | "admin" | "guest";

export interface OtpSignInFormProps {
  readonly audience: OtpAudience;
  /**
   * Where to land after a successful sign-in. Omit when {@link onSignedIn} is
   * given — the guest join flow continues on the same screen rather than
   * navigating, so the invite token never has to survive a round trip.
   */
  readonly redirectTo?: string;
  /** Called instead of navigating. */
  readonly onSignedIn?: () => void;
}

type Step = "email" | "code";

/**
 * Six-digit email OTP sign-in, built against the Better Auth `emailOTP` plugin
 * (PLAN.md → "Organisers: six-digit email OTP on web (10-min expiry, five
 * attempts, 15-s resend cooldown)").
 *
 * The limits enforced here are courtesy only — they stop a user wasting a round
 * trip and make the rules visible. Convex re-enforces every one of them
 * server-side in Sprint 2, together with rate limiting and enumeration
 * protection.
 *
 * With no backend configured the form renders in full but is inert, so the
 * screen can still be reviewed offline.
 */
export function OtpSignInForm({ audience, redirectTo, onSignedIn }: OtpSignInFormProps) {
  const router = useRouter();

  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState<string | undefined>(undefined);
  const [attemptsLeft, setAttemptsLeft] = useState(OTP_MAX_ATTEMPTS);
  const [resendAt, setResendAt] = useState<number | undefined>(undefined);
  const [now, setNow] = useState(() => Date.now());

  // Drive the resend countdown. The interval only exists while a cooldown is
  // running, so an idle form does no work.
  useEffect(() => {
    if (resendAt === undefined) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 500);
    return () => {
      clearInterval(timer);
    };
  }, [resendAt]);

  const cooldownRemaining = resendAt === undefined ? 0 : Math.max(0, (resendAt - now) / 1000);
  const canResend = cooldownRemaining <= 0;
  const emailValid = isProbablyEmail(email);

  const sendCode = useCallback(async (address: string) => {
    setPending(true);
    setError(undefined);
    try {
      const result = await authClient.emailOtp.sendVerificationOtp({
        email: address,
        type: "sign-in",
      });
      if (result.error) {
        setError(authErrorMessage(result.error));
        return false;
      }
      setResendAt(Date.now() + OTP_RESEND_COOLDOWN_SECONDS * 1000);
      setNow(Date.now());
      setAttemptsLeft(OTP_MAX_ATTEMPTS);
      return true;
    } catch (caught) {
      setError(authErrorMessage(caught));
      return false;
    } finally {
      setPending(false);
    }
  }, []);

  const handleRequest = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const address = normaliseEmail(email);
      if (!isProbablyEmail(address)) {
        setError("That does not look like an email address.");
        return;
      }
      setEmail(address);
      setNotice(undefined);
      if (await sendCode(address)) {
        setCode("");
        setStep("code");
      }
    },
    [email, sendCode],
  );

  const handleResend = useCallback(async () => {
    setNotice(undefined);
    if (await sendCode(email)) {
      setCode("");
      setNotice("New code sent.");
    }
  }, [email, sendCode]);

  const handleVerify = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setPending(true);
      setError(undefined);
      setNotice(undefined);
      try {
        const result = await authClient.signIn.emailOtp({ email, otp: code });
        if (result.error) {
          setAttemptsLeft((remaining) => Math.max(0, remaining - 1));
          setCode("");
          setError(authErrorMessage(result.error));
          return;
        }
        if (onSignedIn) {
          // The guest join flow stays on the page: `useConvexAuth` picks the
          // new identity up on its own, and navigating away would drop the
          // invite token the flow is holding. The cache still has to go, so a
          // Server Component that rendered a signed-out state is not reused.
          router.refresh();
          onSignedIn();
          return;
        }
        // The authenticated shells are Server Components gated on the session
        // cookie, so the cache has to be invalidated as well as navigated.
        if (redirectTo !== undefined) router.replace(redirectTo);
        router.refresh();
      } catch (caught) {
        setAttemptsLeft((remaining) => Math.max(0, remaining - 1));
        setError(authErrorMessage(caught));
      } finally {
        setPending(false);
      }
    },
    [code, email, onSignedIn, redirectTo, router],
  );

  const restart = useCallback(() => {
    setStep("email");
    setCode("");
    setError(undefined);
    setNotice(undefined);
    setResendAt(undefined);
    setAttemptsLeft(OTP_MAX_ATTEMPTS);
  }, []);

  const locked = attemptsLeft <= 0;
  const disabled = !isBackendConfigured || pending || locked;

  return (
    <div className="space-y-5">
      {!isBackendConfigured ? <BackendNotConfigured /> : null}

      {step === "email" ? (
        <form
          onSubmit={(event) => {
            void handleRequest(event);
          }}
          noValidate
          className="space-y-4"
        >
          <TextField
            label="Email address"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="you@example.com"
            value={email}
            onChange={(event) => {
              setEmail(event.target.value);
              setError(undefined);
            }}
            error={error}
            hint={
              audience === "admin"
                ? "Admin access is limited to the server-side allowlist."
                : `We'll email you a ${String(OTP_LENGTH)}-digit code.`
            }
            disabled={disabled}
            autoFocus
          />
          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={pending}
            disabled={disabled || !emailValid}
          >
            Email me a code
          </Button>
        </form>
      ) : (
        <form
          onSubmit={(event) => {
            void handleVerify(event);
          }}
          noValidate
          className="space-y-4"
        >
          <CodeField
            label={`${String(OTP_LENGTH)}-digit code`}
            name="otp"
            value={code}
            onChange={(next) => {
              setCode(next);
              setError(undefined);
            }}
            length={OTP_LENGTH}
            error={error}
            hint={`Sent to ${email}. Expires in ${String(OTP_EXPIRY_MINUTES)} minutes.`}
            disabled={disabled}
            autoFocus
          />

          {notice ? (
            <Callout tone="success" live="polite">
              {notice}
            </Callout>
          ) : null}

          {locked ? (
            <Callout tone="danger" live="assertive">
              Too many wrong codes. Request a new one to try again.
            </Callout>
          ) : attemptsLeft < OTP_MAX_ATTEMPTS ? (
            <p className="text-sm text-muted" aria-live="polite">
              {String(attemptsLeft)} attempt{attemptsLeft === 1 ? "" : "s"} left.
            </p>
          ) : null}

          <Button
            type="submit"
            size="lg"
            fullWidth
            loading={pending}
            disabled={disabled || code.length !== OTP_LENGTH}
          >
            {audience === "guest" ? "Continue" : "Sign in"}
          </Button>

          <div className="flex items-center justify-between gap-3 pt-1">
            <Button variant="ghost" size="sm" onClick={restart} disabled={pending}>
              Use a different email
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void handleResend();
              }}
              disabled={!isBackendConfigured || pending || !canResend}
              className={cn(!canResend && "tabular-nums")}
            >
              {canResend ? "Resend code" : `Resend in ${formatCooldown(cooldownRemaining)}`}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
