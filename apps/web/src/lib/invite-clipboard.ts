import { encodeQr, QR_QUIET_ZONE, type QrMatrix } from "@/lib/contracts";

export type InviteCopyAction = "qr" | "code" | "link" | "all";

export interface InviteClipboardDetails {
  readonly eventName: string;
  readonly groupedCode: string;
  readonly url: string;
}

export interface InviteCopyMenuItem {
  readonly action: InviteCopyAction;
  readonly label: string;
  readonly copiedLabel: string;
}

const TEXT_MIME = "text/plain";
const HTML_MIME = "text/html";
const PNG_MIME = "image/png";

/** The menu stays useful in the support console, where the bearer token is withheld. */
export function inviteCopyMenuItems(hasJoinUrl: boolean): readonly InviteCopyMenuItem[] {
  if (!hasJoinUrl) {
    return [{ action: "code", label: "Copy six-digit code", copiedLabel: "Code copied" }];
  }

  return [
    { action: "qr", label: "Copy QR image", copiedLabel: "QR copied" },
    { action: "code", label: "Copy six-digit code", copiedLabel: "Code copied" },
    { action: "link", label: "Copy join link", copiedLabel: "Link copied" },
    { action: "all", label: "Copy all details", copiedLabel: "All copied" },
  ];
}

export function inviteClipboardText({ eventName, groupedCode, url }: InviteClipboardDetails) {
  return `${eventName}\nJoin code: ${groupedCode}\nJoin link: ${url}`;
}

/**
 * Rich-text destinations get the QR, readable code, and a clickable link in one
 * paste. The bearer URL is deliberately the anchor target rather than visible
 * copy; the same credential was already present in the QR.
 */
export function inviteClipboardHtml(
  { eventName, groupedCode, url }: InviteClipboardDetails,
  qrDataUrl: string,
) {
  const safeName = escapeHtml(eventName);
  const safeCode = escapeHtml(groupedCode);
  const safeUrl = escapeHtml(url);
  const safeQr = escapeHtml(qrDataUrl);

  return [
    '<div style="font-family:system-ui,-apple-system,sans-serif;color:#111">',
    `<p style="margin:0 0 12px;font-size:20px;font-weight:700">Join ${safeName}</p>`,
    `<img src="${safeQr}" alt="QR code to join ${safeName}" width="320" height="320" style="display:block;background:#fff" />`,
    '<p style="margin:16px 0 4px;color:#555;font-size:14px">Six-digit code</p>',
    `<p style="margin:0 0 12px;font-size:32px;font-weight:700;letter-spacing:.18em">${safeCode}</p>`,
    `<p style="margin:0"><a href="${safeUrl}">Open join link</a></p>`,
    "</div>",
  ].join("");
}

export function copyInviteText(value: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) return Promise.reject(new Error("Clipboard access is unavailable"));
  return clipboard.writeText(value);
}

export function copyInviteQr(url: string): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined || typeof ClipboardItem === "undefined") {
    return Promise.reject(new Error("Image clipboard access is unavailable"));
  }

  const canvas = renderQrCanvas(encodeQr(url));
  return clipboard.write([new ClipboardItem({ [PNG_MIME]: canvasToPng(canvas) })]);
}

/**
 * A clipboard item carries equivalent representations of the whole invite:
 * rich editors choose HTML, chat/image tools choose the share card, and plain
 * text fields choose the code and link. Browsers without rich clipboard support
 * still receive the useful text representation.
 */
export function copyAllInviteDetails(details: InviteClipboardDetails): Promise<"rich" | "text"> {
  const clipboard = navigator.clipboard;
  if (clipboard === undefined) return Promise.reject(new Error("Clipboard access is unavailable"));

  const text = inviteClipboardText(details);
  if (typeof ClipboardItem === "undefined" || clipboard.write === undefined) {
    return clipboard.writeText(text).then(() => "text");
  }

  const matrix = encodeQr(details.url);
  const qrCanvas = renderQrCanvas(matrix);
  const shareCard = renderInviteShareCard(details, matrix);
  const item = new ClipboardItem({
    [PNG_MIME]: canvasToPng(shareCard),
    [HTML_MIME]: new Blob([inviteClipboardHtml(details, qrCanvas.toDataURL(PNG_MIME))], {
      type: HTML_MIME,
    }),
    [TEXT_MIME]: new Blob([text], { type: TEXT_MIME }),
  });

  return clipboard
    .write([item])
    .then(() => "rich" as const)
    .catch(() => clipboard.writeText(text).then(() => "text" as const));
}

function renderQrCanvas(matrix: QrMatrix): HTMLCanvasElement {
  const extent = matrix.size + QR_QUIET_ZONE * 2;
  const scale = Math.max(1, Math.floor(1024 / extent));
  const canvas = document.createElement("canvas");
  canvas.width = extent * scale;
  canvas.height = extent * scale;

  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable");
  drawQr(context, matrix, 0, 0, scale);
  return canvas;
}

function drawQr(
  context: CanvasRenderingContext2D,
  matrix: QrMatrix,
  left: number,
  top: number,
  scale: number,
) {
  const extent = matrix.size + QR_QUIET_ZONE * 2;
  context.fillStyle = "#ffffff";
  context.fillRect(left, top, extent * scale, extent * scale);
  context.fillStyle = "#000000";

  for (let y = 0; y < matrix.size; y += 1) {
    for (let x = 0; x < matrix.size; x += 1) {
      if (matrix.modules[y * matrix.size + x] !== true) continue;
      context.fillRect(
        left + (x + QR_QUIET_ZONE) * scale,
        top + (y + QR_QUIET_ZONE) * scale,
        scale,
        scale,
      );
    }
  }
}

function renderInviteShareCard(
  details: InviteClipboardDetails,
  matrix: QrMatrix,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 900;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("Canvas rendering is unavailable");

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  const qrArea = 756;
  const qrExtent = matrix.size + QR_QUIET_ZONE * 2;
  const qrScale = Math.floor(qrArea / qrExtent);
  const qrSize = qrExtent * qrScale;
  const qrInset = Math.floor((qrArea - qrSize) / 2);
  drawQr(context, matrix, 72 + qrInset, 72 + qrInset, qrScale);

  context.fillStyle = "#6d28d9";
  context.font = "700 30px system-ui, -apple-system, sans-serif";
  context.fillText("PARTYBOOTH", 900, 168);

  context.fillStyle = "#111111";
  context.font = "700 58px system-ui, -apple-system, sans-serif";
  context.fillText(fitText(context, `Join ${details.eventName}`, 620), 900, 260);

  context.fillStyle = "#666666";
  context.font = "500 28px system-ui, -apple-system, sans-serif";
  context.fillText("Scan the QR or enter this code", 900, 362);

  context.fillStyle = "#111111";
  context.font = "700 76px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.fillText(details.groupedCode, 900, 466);

  context.fillStyle = "#666666";
  context.font = "500 26px system-ui, -apple-system, sans-serif";
  context.fillText(shortJoinAddress(details.url), 900, 550);
  return canvas;
}

function shortJoinAddress(url: string) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}/join`;
  } catch {
    return "Open the join link";
  }
}

function fitText(context: CanvasRenderingContext2D, value: string, maxWidth: number) {
  if (context.measureText(value).width <= maxWidth) return value;
  let fitted = value;
  while (fitted.length > 1 && context.measureText(`${fitted}…`).width > maxWidth) {
    fitted = fitted.slice(0, -1);
  }
  return `${fitted.trimEnd()}…`;
}

function canvasToPng(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob === null) {
        reject(new Error("The QR image could not be rendered"));
        return;
      }
      resolve(blob);
    }, PNG_MIME);
  });
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
