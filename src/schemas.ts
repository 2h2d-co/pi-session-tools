import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const entryId = Type.String({ minLength: 1, maxLength: 128 });

export const inspectSchema = Type.Object(
  {
    view: StringEnum(["overview", "ancestors", "children", "search", "read"]),
    entryId: Type.Optional(entryId),
    query: Type.Optional(Type.String({ minLength: 1, maxLength: 256 })),
    limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })),
    before: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    after: Type.Optional(Type.Integer({ minimum: 0, maximum: 10 })),
    includeToolResults: Type.Optional(Type.Boolean()),
    cursor: Type.Optional(Type.String({ minLength: 1, maxLength: 2048 })),
  },
  { additionalProperties: false },
);

export const handoffSchema = Type.Object(
  {
    expectedSessionId: Type.String({ minLength: 1, maxLength: 128 }),
    mode: StringEnum(["navigate", "fork", "compact", "new"]),
    targetEntryId: Type.Optional(entryId),
    compactionInstructions: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
    handoff: Type.Object(
      {
        kind: StringEnum(["inline", "file"]),
        text: Type.Optional(
          Type.String({
            minLength: 1,
            maxLength: 16000,
            description: "Inline findings, current constraints, completed work, and next steps.",
          }),
        ),
        path: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })),
        instruction: Type.Optional(Type.String({ minLength: 1, maxLength: 8000 })),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export type InspectInput = Static<typeof inspectSchema>;
export type HandoffInput = Static<typeof handoffSchema>;

export function validateHandoff(input: HandoffInput): void {
  const targeted = input.mode === "navigate" || input.mode === "fork";
  if (targeted !== (input.targetEntryId !== undefined)) {
    throw new Error("targetEntryId is required only for navigate and fork.");
  }
  if (input.mode !== "compact" && input.compactionInstructions !== undefined) {
    throw new Error("compactionInstructions is allowed only for compact.");
  }
  const { handoff } = input;
  if (handoff.kind === "inline") {
    if (!handoff.text?.trim() || handoff.path !== undefined || handoff.instruction !== undefined) {
      throw new Error("An inline handoff requires text and must not include path or instruction.");
    }
  } else if (!handoff.path?.trim() || !handoff.instruction?.trim() || handoff.text !== undefined) {
    throw new Error("A file handoff requires path and instruction and must not include text.");
  }
}
