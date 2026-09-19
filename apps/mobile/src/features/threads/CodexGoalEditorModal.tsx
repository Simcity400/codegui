import { CODEX_GOAL_OBJECTIVE_MAX_CHARS, type OrchestrationThreadGoal } from "@t3tools/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";

export interface CodexGoalEditorSubmission {
  readonly objective: string;
  /** `null` removes the budget. Absent when unchanged. */
  readonly tokenBudget?: number | null;
}

function parseTokenBudget(raw: string): number | null | "invalid" {
  const trimmed = raw.replace(/[,\s_]/g, "");
  if (trimmed === "") return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value > 0 ? value : "invalid";
}

/** Objective and token budget for a new or existing native Codex Goal. */
export function CodexGoalEditorModal(props: {
  readonly visible: boolean;
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={props.onClose}
    >
      {/* Mount from the current goal when opened. Usage updates must not
          reset the objective while the user is editing it. */}
      {props.visible ? (
        <CodexGoalEditorForm
          key={props.goal === null ? "new" : props.goal.createdAt}
          goal={props.goal}
          saving={props.saving}
          onClose={props.onClose}
          onSubmit={props.onSubmit}
        />
      ) : null}
    </Modal>
  );
}

function CodexGoalEditorForm(props: {
  readonly goal: OrchestrationThreadGoal | null;
  readonly saving: boolean;
  readonly onClose: () => void;
  readonly onSubmit: (submission: CodexGoalEditorSubmission) => void;
}) {
  const [objective, setObjective] = useState(props.goal?.objective ?? "");
  const [tokenBudget, setTokenBudget] = useState(
    props.goal?.tokenBudget == null ? "" : String(props.goal.tokenBudget),
  );
  const [validationError, setValidationError] = useState<string | null>(null);
  const isEditing = props.goal !== null;

  const submit = () => {
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
    <View className="flex-1 items-center justify-center bg-backdrop px-6">
      <View className="w-full rounded-[24px] bg-card px-5 pb-4 pt-5">
        <Text className="text-lg font-t3-medium">{isEditing ? "Edit goal" : "Set a goal"}</Text>
        <ScrollView
          className="mt-3 max-h-80"
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          <Text className="mb-1 text-xs font-t3-medium text-foreground-muted">Objective</Text>
          <TextInput
            accessibilityLabel="Goal objective"
            autoFocus
            multiline
            value={objective}
            onChangeText={setObjective}
            placeholder="Make the test suite pass on CI and open a pull request"
            className="min-h-[96px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
            style={{ textAlignVertical: "top" }}
          />
          <Text className="mb-1 mt-3 text-xs font-t3-medium text-foreground-muted">
            Token budget (optional)
          </Text>
          <TextInput
            accessibilityLabel="Goal token budget"
            keyboardType="number-pad"
            value={tokenBudget}
            onChangeText={setTokenBudget}
            placeholder="No limit"
            className="min-h-[48px] rounded-2xl border border-input-border bg-input px-3.5 py-3 font-sans text-base text-foreground"
          />
          {validationError === null ? null : (
            <Text className="mt-2 text-sm text-danger-foreground">{validationError}</Text>
          )}
        </ScrollView>
        <View className="mt-4 flex-row justify-end gap-1">
          <View className="overflow-hidden rounded-full">
            <Pressable
              accessibilityRole="button"
              className="min-h-10 items-center justify-center px-4 active:bg-subtle"
              onPress={props.onClose}
            >
              <Text className="text-base font-t3-medium">Cancel</Text>
            </Pressable>
          </View>
          <View className="overflow-hidden rounded-full">
            <Pressable
              accessibilityRole="button"
              disabled={props.saving}
              className={cn(
                "min-h-10 items-center justify-center px-4 active:bg-subtle",
                props.saving && "opacity-50",
              )}
              onPress={submit}
            >
              <Text className="text-base font-t3-medium">
                {props.saving ? "Saving..." : isEditing ? "Save goal" : "Start goal"}
              </Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}
