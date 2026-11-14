/**
 * The text node's composer: the shared prompt sheet configured with the text
 * model and the prompt's live counter. Its attachments are the node's image
 * inputs; sending runs the mock text provider, whose text lands on the card
 * itself. The sheet never shows the output, so the card stays the one place
 * the generated text lives.
 */
import type { ComposerState } from "../../flow/composer-state";
import { isTextModel, TEXT_MODELS, textModelLabel } from "../../flow/node-kinds";
import type { NodeDetail } from "../../flow/shared";
import { ComposerModelSelect } from "../ComposerModelSelect";
import { ComposerSheet } from "./ComposerSheet";

/** The prompt's limit, shown beside the field as a live counter. */
const PROMPT_LIMIT = 10000;

export interface TextComposerProps {
  readonly detail: NodeDetail;
  readonly state: ComposerState;
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly assetUrls: () => Readonly<Record<string, string>>;
  readonly running: () => boolean;
  readonly onClose: () => void;
  readonly onRun: () => void;
  readonly onCancel: () => void;
  readonly onRemoveInput: (id: string) => void;
  readonly onUpload: () => void;
}

/** The prompt sheet of a text node, with its image inputs and send button. */
export function TextComposer(props: TextComposerProps) {
  const counter = (): string => `${props.state.prompt().length}/${PROMPT_LIMIT}`;

  return (
    <ComposerSheet
      detail={props.detail}
      state={props.state}
      left={props.left}
      top={props.top}
      width={props.width}
      assetUrls={props.assetUrls}
      running={props.running}
      onClose={props.onClose}
      onRun={props.onRun}
      onCancel={props.onCancel}
      onRemoveInput={props.onRemoveInput}
      onUpload={props.onUpload}
      promptLimit={PROMPT_LIMIT}
      placeholder="描述你想生成的文本内容..."
      counter={counter}
      footerClass="flex-row items-center gap-1 px-1"
      footer={
        <ComposerModelSelect
          accessibilityLabel="Text model"
          value={props.state.textModel()}
          label={textModelLabel(props.state.textModel())}
          models={TEXT_MODELS}
          onChange={(id) => {
            if (isTextModel(id)) props.state.setTextModel(id);
          }}
        />
      }
    />
  );
}
