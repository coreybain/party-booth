"use client";

import { useState } from "react";

import { JoinByCode } from "@/components/join/join-by-code";
import { JoinQrScanner } from "@/components/join/join-qr-scanner";
import { Button } from "@/components/ui/button";

type JoinMethod = "scan" | "code";

/** The public `/join` choice, intentionally opening on camera scanning. */
export function JoinPageContent() {
  const [method, setMethod] = useState<JoinMethod>("scan");

  if (method === "scan") {
    return <JoinQrScanner onEnterCode={() => setMethod("code")} />;
  }

  return (
    <div className="space-y-5">
      <Button variant="secondary" fullWidth onClick={() => setMethod("scan")}>
        Scan the QR code instead
      </Button>
      <JoinByCode />
    </div>
  );
}
