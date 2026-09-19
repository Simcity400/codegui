import { type ReactNode } from "react";

import {
  RIGHT_PANEL_SHEET_CLASS_NAME,
  RIGHT_PANEL_SHEET_LAYER_CLASS_NAME,
} from "../rightPanelLayout";
import { Sheet, SheetPopup } from "./ui/sheet";

export function RightPanelSheet(props: {
  animationDurationMs: number;
  children: ReactNode;
  open: boolean;
  underFloatingPreview?: boolean;
  fullWidth?: boolean;
  onClose: () => void;
}) {
  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (!open) {
          props.onClose();
        }
      }}
    >
      <SheetPopup
        transitionDurationMs={props.animationDurationMs}
        side="right"
        showCloseButton={false}
        keepMounted
        {...(props.underFloatingPreview
          ? {
              backdropClassName: RIGHT_PANEL_SHEET_LAYER_CLASS_NAME,
              viewportClassName: RIGHT_PANEL_SHEET_LAYER_CLASS_NAME,
            }
          : {})}
        className={
          props.fullWidth
            ? "w-screen min-w-0 max-w-none p-0 wco:mt-[env(titlebar-area-height)] wco:h-[calc(100%-env(titlebar-area-height))] wco:max-h-[calc(100%-env(titlebar-area-height))]"
            : RIGHT_PANEL_SHEET_CLASS_NAME
        }
      >
        {props.children}
      </SheetPopup>
    </Sheet>
  );
}
