import {
  codexGoalStatusAction,
  formatCodexGoalStatus,
  formatCodexGoalUsageCompact,
  type CodexGoalSessionActivity,
} from "@t3tools/client-runtime/state/threads";
import { CODEX_GOAL_OBJECTIVE_MAX_CHARS, type OrchestrationThreadGoal } from "@t3tools/contracts";
import { EllipsisIcon, TargetIcon } from "lucide-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import {
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { composerFloatingLayerProps } from "./composerEventScope";

export type CodexGoalStatusAction = NonNullable<ReturnType<typeof codexGoalStatusAction>>;

const STATUS_ACTION_LABELS: Record<CodexGoalStatusAction, string> = {
  pause: "Pause",
  resume: "Resume",
  continue: "Continue",
};

export interface CodexGoalBannerInput {
  readonly id: string;
  readonly goal: OrchestrationThreadGoal;
  readonly activity: CodexGoalSessionActivity;
  readonly busy: boolean;
  readonly onStatusAction: (action: CodexGoalStatusAction) => void;
  readonly onEdit: () => void;
  readonly onClear: () => void;
}

/**
 * The goal row above the composer, one line like the other composer notices:
 * Codex's own status word, the objective, usage, the one status control, and
 * a menu for edit and clear.
 */
export function buildCodexGoalBannerItem(input: CodexGoalBannerInput): ComposerBannerStackItem {
  const { goal, activity, busy } = input;
  const statusAction = codexGoalStatusAction(goal, activity);
  const halted =
    goal.status === "blocked" || goal.status === "usageLimited" || goal.status === "budgetLimited";
  return {
    id: input.id,
    variant: halted ? "warning" : goal.status === "complete" ? "success" : "info",
    icon: <TargetIcon />,
    title: `Goal ${formatCodexGoalStatus(goal.status)}`,
    description: (
      <Tooltip>
        <TooltipTrigger render={<span>{goal.objective}</span>} />
        <TooltipPopup side="top" className="max-w-96 whitespace-normal">
          {goal.objective}
        </TooltipPopup>
      </Tooltip>
    ),
    actions: (
      <span className="flex items-center gap-1">
        <span className="px-1 text-xs tabular-nums text-muted-foreground">
          {formatCodexGoalUsageCompact(goal)}
        </span>
        {statusAction !== null ? (
          <Button
            type="button"
            size="xs"
            variant={halted || activity === "stopped" ? "default" : "ghost"}
            disabled={busy}
            onClick={() => input.onStatusAction(statusAction)}
          >
            {STATUS_ACTION_LABELS[statusAction]}
          </Button>
        ) : null}
        <Menu>
          <MenuTrigger
            disabled={busy}
            render={<Button size="icon-xs" variant="ghost" aria-label="Goal options" />}
          >
            <EllipsisIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" {...composerFloatingLayerProps}>
            <MenuItem onClick={input.onEdit}>Edit goal</MenuItem>
            <MenuItem onClick={input.onClear}>Clear goal</MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    ),
  };
}

export interface CodexGoalEditorSubmission {
  readonly objective: string;
  /** `null` removes the budget. Absent when unchanged. */
  readonly tokenBudget?: number | null;
}

function parseTokenBudget(raw: string): number | null | "invalid" {
  const trimmed = raw.replace(/[,\s_]/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isInteger(value) && value > 0 ? value : "invalid";
}

export function CodexGoalEditorDialog(props: {
  readonly open: boolean;
  /** The goal being edited, or `null` when creating one. */
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  const isEditing = props.goal !== null;
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{isEditing ? "Edit goal" : "Set a goal"}</DialogTitle>
        </DialogHeader>
        {/* Seed on open or goal replacement; progress updates must not reset edits. */}
        {props.open ? (
          <CodexGoalEditorForm
            key={props.goal === null ? "new" : props.goal.createdAt}
            goal={props.goal}
            saving={props.saving}
            onClose={props.onClose}
            onSubmit={props.onSubmit}
          />
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}

function CodexGoalEditorForm(props: {
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  const formId = useId();
  const [objective, setObjective] = useState(props.goal?.objective ?? "");
  const [tokenBudget, setTokenBudget] = useState(
    props.goal?.tokenBudget == null ? "" : String(props.goal.tokenBudget),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEditing = props.goal !== null;

  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedObjective = objective.trim();
    if (trimmedObjective.length === 0) {
      setValidationError("Give the goal an objective.");
      return;
    }
    if (Array.from(trimmedObjective).length > CODEX_GOAL_OBJECTIVE_MAX_CHARS) {
      setValidationError(
        `Keep the objective under ${CODEX_GOAL_OBJECTIVE_MAX_CHARS.toLocaleString()} characters.`,
      );
      return;
    }
    const budget = parseTokenBudget(tokenBudget);
    if (budget === "invalid") {
      setValidationError("The token budget must be a whole number above zero, or empty.");
      return;
    }
    const previousBudget = props.goal?.tokenBudget ?? null;
    props.onSubmit({
      objective: trimmedObjective,
      ...(budget === previousBudget ? {} : { tokenBudget: budget }),
    });
  };

  return (
    <>
      <DialogPanel>
        <form id={formId} className="space-y-4" onSubmit={submit}>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-objective`}>Objective</Label>
            <Textarea
              id={`${formId}-objective`}
              autoFocus
              placeholder="Make the test suite pass on CI and open a pull request"
              value={objective}
              onChange={(event) => setObjective(event.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-budget`}>Token budget (optional)</Label>
            <Input
              id={`${formId}-budget`}
              inputMode="numeric"
              placeholder="No limit"
              value={tokenBudget}
              onChange={(event) => setTokenBudget(event.target.value)}
            />
          </div>
          {validationError ? <p className="text-sm text-destructive">{validationError}</p> : null}
        </form>
      </DialogPanel>
      <DialogFooter className="dark:border-transparent dark:bg-transparent">
        <Button type="button" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button form={formId} type="submit" disabled={props.saving}>
          {props.saving ? "Saving..." : isEditing ? "Save goal" : "Start goal"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function CodexGoalClearDialog(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={props.onOpenChange}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear this goal?</AlertDialogTitle>
          <AlertDialogDescription>
            Codex stops pursuing the objective and forgets its usage. The conversation stays.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              props.onOpenChange(false);
              props.onConfirm();
            }}
          >
            Clear goal
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}
