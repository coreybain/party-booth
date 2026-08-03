import { render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@expo/vector-icons", () => ({
  Ionicons: (props: Record<string, unknown>) =>
    createElement("span", { "data-icon": String(props.name) }),
}));

import { RECORDING_RING_OFFSET, ShutterButton } from "@/components/camera-controls";

describe("recording shutter", () => {
  it("keeps a circular countdown and a sixty-step progress outline", () => {
    render(
      createElement(ShutterButton, {
        recording: true,
        progress: 0.5,
        remaining: 30,
        zoom: 0.4,
        onPressIn: vi.fn(),
        onPressMove: vi.fn(),
        onPressOut: vi.fn(),
      }),
    );

    expect(screen.getByLabelText("Stop recording")).toBeTruthy();
    expect(screen.getByText("30")).toBeTruthy();
    const progress = screen.getByTestId("recording-progress");
    expect(progress.children).toHaveLength(60);
    expect(RECORDING_RING_OFFSET).toBe(-10);
    expect(screen.getByTestId("recording-zoom")).toBeTruthy();
  });
});
