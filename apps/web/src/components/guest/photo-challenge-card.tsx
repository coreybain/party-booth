"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { useMutation } from "convex/react";

import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/callout";
import { appErrorMessage } from "@/lib/app-errors";
import {
  backendApi,
  type GuestPhotoChallenge,
  type PhotoChallengeAssignment,
} from "@/lib/convex-api";
import type { CaptureController } from "@/lib/use-capture-upload";

export function PhotoChallengeCard({
  eventId,
  controller,
  onNotNow,
}: {
  readonly eventId: string;
  readonly controller: CaptureController;
  readonly onNotNow: () => void;
}) {
  const currentOrDraw = useMutation(backendApi.photo_challenges.currentOrDraw);
  const skip = useMutation(backendApi.photo_challenges.skip);
  const resolve = useMutation(backendApi.photo_challenges.resolve);
  const [assignment, setAssignment] = useState<PhotoChallengeAssignment | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    void currentOrDraw({ eventId })
      .then((result) => {
        if (active) applyResult(result, setAssignment);
      })
      .catch((cause: unknown) => {
        if (active) setError(appErrorMessage(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [currentOrDraw, eventId]);

  const review = controller.review;

  async function chooseAnother(): Promise<void> {
    if (!assignment) return;
    setLoading(true);
    setError(undefined);
    try {
      applyResult(await skip({ assignmentId: assignment.id }), setAssignment);
    } catch (cause) {
      setError(appErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  async function confirm(useChallenge: boolean): Promise<void> {
    if (!review) return;
    setLoading(true);
    setError(undefined);
    try {
      if (assignment) {
        const result = await resolve({
          assignmentId: assignment.id,
          outcome: useChallenge ? "used" : "dismissed",
          captureId: review.captureId,
        });
        applyResult(result, setAssignment);
      }
      controller.confirmReview(useChallenge ? assignment?.id : undefined);
    } catch (cause) {
      setError(appErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }

  if (review) {
    return (
      <div className="overflow-hidden rounded-3xl border border-plum/20 bg-plum/[0.06] shadow-sm">
        {review.previewUrl ? (
          <div className="relative aspect-[4/3] w-full bg-ink/5">
            <Image
              src={review.previewUrl}
              alt="Your new photo"
              fill
              unoptimized
              className="object-cover"
            />
          </div>
        ) : null}
        <div className="space-y-4 p-5">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-plum">
              Your photo challenge
            </p>
            <p className="mt-2 text-xl font-semibold leading-snug text-ink">
              {assignment?.prompt ?? "Send this photo?"}
            </p>
          </div>
          {error ? <Callout tone="danger">{error}</Callout> : null}
          <div className="space-y-2">
            {assignment ? (
              <Button size="lg" fullWidth loading={loading} onClick={() => void confirm(true)}>
                Use challenge
              </Button>
            ) : null}
            <Button
              variant="secondary"
              size="lg"
              fullWidth
              disabled={loading}
              onClick={() => void confirm(false)}
            >
              Send without challenge
            </Button>
            <Button
              variant="ghost"
              size="lg"
              fullWidth
              disabled={loading}
              onClick={controller.discardReview}
            >
              Retake
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!assignment && !loading) return null;

  return (
    <div className="rounded-3xl border border-plum/20 bg-gradient-to-br from-plum/[0.09] to-coral/[0.08] p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-[0.18em] text-plum">Photo challenge</p>
      <p className="mt-3 text-xl font-semibold leading-snug text-ink">
        {assignment?.prompt ?? "Finding a fresh idea…"}
      </p>
      {error ? (
        <div className="mt-4">
          <Callout tone="danger">{error}</Callout>
        </div>
      ) : null}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="secondary"
          disabled={!assignment || loading}
          onClick={() => void chooseAnother()}
        >
          Another challenge
        </Button>
        <Button variant="ghost" disabled={loading} onClick={onNotNow}>
          Not now
        </Button>
      </div>
    </div>
  );
}

function applyResult(
  result: GuestPhotoChallenge,
  setAssignment: (assignment: PhotoChallengeAssignment | undefined) => void,
): void {
  setAssignment(result.outcome === "available" ? result.assignment : undefined);
}
