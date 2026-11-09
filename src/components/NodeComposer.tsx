/** The composer sheet: the always-available native panel attached to a card. */
import { Image as NshImage, Text, View } from "nsh";
import { Button, Input } from "nsh/base";
import type { InputItemSummary, NodeDetail, ResultItemSummary } from "@flow/native";
import type { ComposerState } from "../flow/composer-state";
import { IMAGE_ASPECTS, type ImageAspect, modelLabel, statusLabel } from "../flow/node-kinds";

export interface NodeComposerProps {
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
  readonly onReorderInputs: (ids: string[]) => void;
  readonly onUpload: () => void;
  readonly onSaveBody: () => void;
  /** Reports the laid-out height, so the page can place the sheet. */
  readonly onSize?: (height: number) => void;
}

const sectionClass = "gap-1.5";
const labelClass = "text-[11px] font-medium text-muted-foreground";

/** The node's native composer: inputs, prompt, model and run. */
export function NodeComposer(props: NodeComposerProps) {
  return (
    <View
      testID="node-composer"
      class="absolute z-20 gap-3 rounded-(--radius) border border-border bg-popover p-3 shadow-lg"
      style={{ left: props.left, top: props.top, width: props.width }}
      onLayout={(event) => props.onSize?.(event.bounds.size.height)}
    >
      <View class="flex-row items-center justify-between">
        <View class="gap-0.5">
          <Text class="text-sm font-semibold text-popover-foreground">
            {props.detail.node.title}
          </Text>
          <Text class="text-[11px] text-muted-foreground">
            {modelLabel(props.detail.node.kind)}
            {statusLabel(props.detail.node.status) === ""
              ? ""
              : ` · ${statusLabel(props.detail.node.status)}`}
          </Text>
        </View>
        <Button
          accessibilityLabel="Close composer"
          onPress={props.onClose}
          class="rounded-md px-2 py-1 active:bg-muted focus:bg-accent"
        >
          <Text class="text-sm text-muted-foreground">×</Text>
        </Button>
      </View>

      {errorOf(props.detail) === "" ? null : (
        <View class="rounded-md bg-muted px-2 py-1.5">
          <Text class="text-xs text-destructive">{errorOf(props.detail)}</Text>
        </View>
      )}

      <View class={sectionClass}>
        <Text class={labelClass}>Inputs · {props.detail.inputs.length}</Text>
        {props.detail.inputs.length === 0 ? (
          <Text class="text-xs text-muted-foreground">
            Connect an upstream node or upload an image.
          </Text>
        ) : (
          inputGroups(props.detail.inputs).map((group) => (
            <View class="gap-1">
              <Text class="text-[10px] font-medium text-muted-foreground">{group.title}</Text>
              {group.entries.map((entry) => (
                <InputChip
                  input={entry.input}
                  index={entry.index}
                  count={props.detail.inputs.length}
                  assetUrls={props.assetUrls}
                  onRemove={props.onRemoveInput}
                  onMove={(index, delta) => moveInput(props, index, delta)}
                />
              ))}
            </View>
          ))
        )}
      </View>

      <View class={sectionClass}>
        <Text class={labelClass}>Prompt</Text>
        <Input
          testID="composer-prompt"
          accessibilityLabel="Prompt"
          value={props.state.prompt()}
          onChange={(event) => props.state.setPrompt(event.value)}
          placeholder="Describe what this node should make…"
          multiline
          maxLength={4000}
          submitBehavior="newline"
          class="min-h-16 rounded-md border border-input bg-card px-2 py-1.5 text-sm text-card-foreground placeholder:text-muted-foreground"
        />
      </View>

      <View class="flex-row items-center justify-between gap-2">
        <View testID="composer-model" class="flex-1 rounded-md border border-border px-2 py-1.5">
          <Text class="text-xs text-card-foreground">
            Model · {modelLabel(props.detail.node.kind)}
          </Text>
        </View>
        <Button
          testID="composer-upload"
          onPress={props.onUpload}
          class="rounded-md border border-border px-2 py-1.5 active:bg-muted"
        >
          <Text class="text-xs text-card-foreground">Upload</Text>
        </Button>
      </View>

      {props.detail.node.kind === "image" ? (
        <View class="flex-row items-center justify-between gap-2">
          <View class="flex-row items-center gap-1">
            {IMAGE_ASPECTS.map((aspect: ImageAspect) => (
              <Button
                testID={`composer-aspect-${aspect}`}
                selected={props.state.aspect() === aspect}
                onPress={() => props.state.setAspect(aspect)}
                class="rounded-md border border-border px-2 py-1 active:bg-muted selected:bg-muted"
              >
                <Text class="text-xs text-card-foreground">{aspect}</Text>
              </Button>
            ))}
          </View>
          <View class="flex-row items-center gap-1">
            <Button
              accessibilityLabel="Fewer images"
              onPress={() => props.state.setCount(-1)}
              class="rounded-md border border-border px-2 py-1 active:bg-muted"
            >
              <Text class="text-xs text-card-foreground">−</Text>
            </Button>
            <Text class="min-w-6 text-center text-xs tabular-nums text-card-foreground">
              {props.state.count()}
            </Text>
            <Button
              accessibilityLabel="More images"
              onPress={() => props.state.setCount(1)}
              class="rounded-md border border-border px-2 py-1 active:bg-muted"
            >
              <Text class="text-xs text-card-foreground">+</Text>
            </Button>
          </View>
        </View>
      ) : null}

      {props.detail.node.kind === "text" ? (
        <View class={sectionClass}>
          <View class="flex-row items-center justify-between">
            <Text class={labelClass}>Text body</Text>
            <Button
              testID="composer-save-body"
              onPress={props.onSaveBody}
              class="rounded-md px-2 py-1 active:bg-muted"
            >
              <Text class="text-xs text-card-foreground">Save text</Text>
            </Button>
          </View>
          <Input
            testID="composer-body"
            accessibilityLabel="Text body"
            value={props.state.body()}
            onChange={(event) => props.state.setBody(event.value)}
            multiline
            submitBehavior="newline"
            class="min-h-24 rounded-md border border-input bg-card px-2 py-1.5 text-sm text-card-foreground"
          />
        </View>
      ) : null}

      {resultTextOf(props.detail) === "" ? null : (
        <View class={sectionClass}>
          <Text class={labelClass}>Latest text</Text>
          <Text class="max-h-40 text-xs text-card-foreground">{resultTextOf(props.detail)}</Text>
        </View>
      )}

      {imageItemsOf(props.detail).length === 0 ? null : (
        <View class={sectionClass}>
          <Text class={labelClass}>Latest images</Text>
          <View class="flex-row flex-wrap gap-1">
            {imageItemsOf(props.detail)
              .slice(0, 4)
              .map((item) => (
                <ResultThumb item={item} assetUrls={props.assetUrls} />
              ))}
          </View>
        </View>
      )}

      <View class="flex-row items-center justify-end gap-2">
        {props.running() ? (
          <Button
            testID="composer-cancel"
            onPress={props.onCancel}
            class="rounded-md border border-border px-3 py-1.5 active:bg-muted"
          >
            <Text class="text-sm text-card-foreground">Cancel</Text>
          </Button>
        ) : (
          <Button
            testID="composer-run"
            onPress={props.onRun}
            class="rounded-md bg-primary px-3 py-1.5 active:opacity-90"
          >
            <Text class="text-sm font-medium text-primary-foreground">
              {props.detail.batch ? "Regenerate" : "Run"}
            </Text>
          </Button>
        )}
      </View>
    </View>
  );
}

function moveInput(props: NodeComposerProps, index: number, delta: number): void {
  const ids = props.detail.inputs.map((input) => input.id);
  const next = index + delta;
  if (next < 0 || next >= ids.length) return;
  const current = ids[index];
  const other = ids[next];
  if (!current || !other) return;
  ids[index] = other;
  ids[next] = current;
  props.onReorderInputs(ids);
}

interface InputChipProps {
  readonly input: InputItemSummary;
  readonly index: number;
  readonly count: number;
  readonly assetUrls: () => Readonly<Record<string, string>>;
  readonly onRemove: (id: string) => void;
  readonly onMove: (index: number, delta: number) => void;
}

function InputChip(props: InputChipProps) {
  return (
    <View class="flex-row items-center gap-2 rounded-md border border-border px-2 py-1">
      <If when={inputUrl(props.input, props.assetUrls())}>
        {(url) => <NshImage src={url()} style={{ width: 28, height: 28, borderRadius: 4 }} />}
      </If>
      <View class="flex-1 gap-0.5">
        <Text class="text-[10px] text-muted-foreground">
          {props.input.kind === "image" ? "Image" : "Text"}
        </Text>
        <Text class="text-xs text-card-foreground">{chipLabel(props.input)}</Text>
      </View>
      <Button
        accessibilityLabel="Move input up"
        onPress={() => props.onMove(props.index, -1)}
        disabled={props.index === 0}
        class="rounded-md px-1.5 py-0.5 active:bg-muted disabled:opacity-30"
      >
        <Text class="text-xs text-muted-foreground">↑</Text>
      </Button>
      <Button
        accessibilityLabel="Move input down"
        onPress={() => props.onMove(props.index, 1)}
        disabled={props.index === props.count - 1}
        class="rounded-md px-1.5 py-0.5 active:bg-muted disabled:opacity-30"
      >
        <Text class="text-xs text-muted-foreground">↓</Text>
      </Button>
      <Button
        accessibilityLabel="Remove input"
        onPress={() => props.onRemove(props.input.id)}
        class="rounded-md px-1.5 py-0.5 active:bg-muted"
      >
        <Text class="text-xs text-destructive">×</Text>
      </Button>
    </View>
  );
}

function ResultThumb(props: {
  readonly item: ResultItemSummary;
  readonly assetUrls: () => Readonly<Record<string, string>>;
}) {
  return (
    <If when={itemUrl(props.item, props.assetUrls())}>
      {(url) => <NshImage src={url()} style={{ width: 64, height: 64, borderRadius: 6 }} />}
    </If>
  );
}

interface InputEntry {
  readonly input: InputItemSummary;
  readonly index: number;
}

interface InputGroup {
  readonly key: string;
  readonly title: string;
  readonly entries: InputEntry[];
}

/** Consecutive inputs from one source, so a source's items read together. */
function inputGroups(inputs: readonly InputItemSummary[]): InputGroup[] {
  const groups: InputGroup[] = [];
  inputs.forEach((input, index) => {
    const key = input.edgeId ?? "local";
    const title = input.edgeId ? `From ${input.sourceTitle ?? "upstream"}` : "Uploaded";
    const last = groups[groups.length - 1];
    if (last?.key === key) {
      last.entries.push({ input, index });
      return;
    }
    groups.push({ key, title, entries: [{ input, index }] });
  });
  return groups;
}

function chipLabel(input: InputItemSummary): string {
  if (input.kind === "image") {
    return input.asset?.name ?? input.item?.asset?.name ?? "Image";
  }
  const text = (input.item?.text ?? input.text).replace(/\s+/g, " ").trim();
  if (text === "") return "Empty text";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function errorOf(detail: NodeDetail): string {
  if (detail.node.status !== "failed") return "";
  return detail.latestBatch?.status === "failed" ? detail.latestBatch.error : "";
}

function resultTextOf(detail: NodeDetail): string {
  return detail.batch?.items.find((item) => item.kind === "text")?.text ?? "";
}

function imageItemsOf(detail: NodeDetail): ResultItemSummary[] {
  return detail.batch?.items.filter((item) => item.kind === "image") ?? [];
}

function itemUrl(
  item: ResultItemSummary,
  assetUrls: Readonly<Record<string, string>>,
): string | null {
  return item.assetId ? (assetUrls[item.assetId] ?? null) : null;
}

function inputUrl(
  input: InputItemSummary,
  assetUrls: Readonly<Record<string, string>>,
): string | null {
  const assetId = input.assetId ?? input.item?.assetId;
  return assetId ? (assetUrls[assetId] ?? null) : null;
}
