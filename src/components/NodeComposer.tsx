/** The composer sheet: the always-available native panel attached to a card. */
import { computed, Image as NshImage, Text, token, View } from "nsh";
import { Button, Input } from "nsh/base";
import type { InputItemSummary, NodeDetail, PortIncoming, ResultItemSummary } from "@flow/native";
import type { ComposerState } from "../flow/composer-state";
import {
  IMAGE_ASPECTS,
  type ImageAspect,
  type InputPort,
  modelLabel,
  nodeKind,
  statusLabel,
} from "../flow/node-kinds";
import { type PortVisual, portVisual } from "../flow/port-visuals";
import { Icon } from "./Icon";

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
}

const sectionClass = "gap-1.5";
const labelClass = "text-[11px] font-medium text-muted-foreground";

/** The node's native composer: inputs, prompt, model and run. */
export function NodeComposer(props: NodeComposerProps) {
  // A detail reload replaces the record, not necessarily the content. These
  // derived accessors keep same-kind reloads from remounting sections and
  // lists: the kind computed compares equal, and rows reconcile by key.
  const kind = computed(() => props.detail.node.kind);
  const imageItems = computed(
    () => props.detail.batch?.items.filter((item) => item.kind === "image") ?? [],
  );
  const groupRows = computed(() =>
    inputGroups(props.detail.inputs, props.detail.node.kind, props.detail.incoming),
  );

  return (
    <View
      testID="node-composer"
      class="absolute z-20 gap-3 rounded-(--radius) border border-border bg-popover p-3 shadow-lg"
      style={{ left: props.left, top: props.top, width: props.width }}
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
        <If when={props.detail.inputs.length === 0}>
          <Text class="text-xs text-muted-foreground">
            Connect an upstream node or upload an image.
          </Text>
        </If>
        <View class="gap-1">
          <Each of={groupRows()} key={(group) => group.id}>
            {(group) => (
              <View class="gap-1">
                <View class="flex-row items-center gap-1">
                  <If when={group().visual}>
                    {(visual) => (
                      <Icon
                        icon={visual().icon}
                        size={12}
                        strokeWidth={2.2}
                        tint={() => token(visual().token)}
                      />
                    )}
                  </If>
                  <Text class="text-[10px] font-medium text-muted-foreground">{group().title}</Text>
                  <Text class="text-[10px] text-muted-foreground">{group().detail}</Text>
                </View>
                <View>
                  <Each of={group().entries} key={(entry) => entry.input.id}>
                    {(entry) => (
                      <InputChip
                        input={() => entry().input}
                        index={() => entry().index}
                        count={() => entry().count}
                        assetUrls={props.assetUrls}
                        onRemove={props.onRemoveInput}
                        onMove={(id, delta) => moveInput(props, id, delta)}
                      />
                    )}
                  </Each>
                </View>
              </View>
            )}
          </Each>
        </View>
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

      <If when={kind() === "image"}>
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
      </If>

      <If when={kind() === "text"}>
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
      </If>

      {resultTextOf(props.detail) === "" ? null : (
        <View class={sectionClass}>
          <Text class={labelClass}>Latest text</Text>
          <Text class="max-h-40 text-xs text-card-foreground">{resultTextOf(props.detail)}</Text>
        </View>
      )}

      <If when={imageItems().length > 0}>
        <View class={sectionClass}>
          <Text class={labelClass}>Latest images</Text>
          <View class="flex-row flex-wrap gap-1">
            <Each of={imageItems().slice(0, 4)} key={(item) => item.id}>
              {(item) => <ResultThumb item={item} assetUrls={props.assetUrls} />}
            </Each>
          </View>
        </View>
      </If>

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

function moveInput(props: NodeComposerProps, id: string, delta: number): void {
  const inputs = props.detail.inputs;
  const current = inputs.findIndex((input) => input.id === id);
  if (current < 0) return;
  const portId = inputs[current]?.portId;
  // Reorder within the port only: the nearest input of the same port in the
  // direction of travel takes this row's place.
  let other = -1;
  for (let index = current + delta; index >= 0 && index < inputs.length; index += delta) {
    if (inputs[index]?.portId === portId) {
      other = index;
      break;
    }
  }
  if (other < 0) return;
  const ids = inputs.map((input) => input.id);
  const moved = ids[current];
  const displaced = ids[other];
  if (!moved || !displaced) return;
  ids[current] = displaced;
  ids[other] = moved;
  props.onReorderInputs(ids);
}

interface InputChipProps {
  /** The row's item accessor: a retained row follows reorders and edits. */
  readonly input: () => InputItemSummary;
  readonly index: () => number;
  readonly count: () => number;
  readonly assetUrls: () => Readonly<Record<string, string>>;
  readonly onRemove: (id: string) => void;
  readonly onMove: (id: string, delta: number) => void;
}

function InputChip(props: InputChipProps) {
  return (
    <View class="flex-row items-center gap-2 rounded-md border border-border px-2 py-1">
      <If when={inputUrl(props.input(), props.assetUrls())}>
        {(url) => <NshImage src={url()} style={{ width: 28, height: 28, borderRadius: 4 }} />}
      </If>
      <View class="flex-1 gap-0.5">
        <Text class="text-[10px] text-muted-foreground">{sourceLabel(props.input())}</Text>
        <Text class="text-xs text-card-foreground">{chipLabel(props.input())}</Text>
      </View>
      <Button
        accessibilityLabel="Move input up"
        onPress={() => props.onMove(props.input().id, -1)}
        disabled={props.index() === 0}
        class="rounded-md px-1.5 py-0.5 active:bg-muted disabled:opacity-30"
      >
        <Text class="text-xs text-muted-foreground">↑</Text>
      </Button>
      <Button
        accessibilityLabel="Move input down"
        onPress={() => props.onMove(props.input().id, 1)}
        disabled={props.index() === props.count() - 1}
        class="rounded-md px-1.5 py-0.5 active:bg-muted disabled:opacity-30"
      >
        <Text class="text-xs text-muted-foreground">↓</Text>
      </Button>
      <Button
        accessibilityLabel="Remove input"
        onPress={() => props.onRemove(props.input().id)}
        class="rounded-md px-1.5 py-0.5 active:bg-muted"
      >
        <Text class="text-xs text-destructive">×</Text>
      </Button>
    </View>
  );
}

function ResultThumb(props: {
  /** The row's item accessor: thumbnails reconcile by item id. */
  readonly item: () => ResultItemSummary;
  readonly assetUrls: () => Readonly<Record<string, string>>;
}) {
  return (
    <If when={itemUrl(props.item(), props.assetUrls())}>
      {(url) => <NshImage src={url()} style={{ width: 64, height: 64, borderRadius: 6 }} />}
    </If>
  );
}

interface InputEntry {
  readonly input: InputItemSummary;
  /** The row's index and count inside its own port's list. */
  readonly index: number;
  readonly count: number;
}

interface InputGroup {
  /** Unique per port, so rows reconcile across a reload. */
  readonly id: string;
  readonly title: string;
  /** The edge slots in use, such as "2 / 16". */
  readonly detail: string;
  readonly visual: PortVisual | null;
  readonly entries: InputEntry[];
}

/** One group per input port that has items, in the schema's order. */
function inputGroups(
  inputs: readonly InputItemSummary[],
  kind: string,
  incoming: readonly PortIncoming[],
): InputGroup[] {
  const ports = nodeKind(kind).inputs;
  const counts = new Map(incoming.map((entry) => [entry.portId, entry.edges]));
  const groups: InputGroup[] = [];
  for (const port of ports) {
    const matches = inputs.filter((input) => input.portId === port.id);
    // Capacity is counted in connectors, not rows: an edge from a source
    // with no items still occupies a slot, so its port stays visible.
    const edges = counts.get(port.id) ?? 0;
    if (matches.length > 0 || edges > 0) groups.push(groupOf(port, matches, edges));
  }
  const known = new Set(ports.map((port) => port.id));
  const other = inputs.filter((input) => !known.has(input.portId));
  if (other.length > 0) {
    groups.push({
      id: "other",
      title: "Other inputs",
      detail: "",
      visual: null,
      entries: other.map((input, index) => ({ input, index, count: other.length })),
    });
  }
  return groups;
}

/** One port's group, with the edge slots its connectors occupy. */
function groupOf(port: InputPort, matches: readonly InputItemSummary[], edges: number): InputGroup {
  return {
    id: port.id,
    title: port.name,
    detail: `${edges} / ${port.capacity}`,
    visual: portVisual(port.kind),
    entries: matches.map((input, index) => ({ input, index, count: matches.length })),
  };
}

function chipLabel(input: InputItemSummary): string {
  if (input.kind === "image") {
    return input.asset?.name ?? input.item?.asset?.name ?? "Image";
  }
  const text = (input.item?.text ?? input.text).replace(/\s+/g, " ").trim();
  if (text === "") return "Empty text";
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

/** A chip's provenance line: its type and the upstream card, if any. */
function sourceLabel(input: InputItemSummary): string {
  const kind = input.kind === "image" ? "Image" : "Text";
  if (!input.edgeId) return input.kind === "image" ? "Uploaded image" : "Local text";
  return `${kind} · from ${input.sourceTitle ?? "upstream"}`;
}

function errorOf(detail: NodeDetail): string {
  if (detail.node.status !== "failed") return "";
  return detail.latestBatch?.status === "failed" ? detail.latestBatch.error : "";
}

function resultTextOf(detail: NodeDetail): string {
  return detail.batch?.items.find((item) => item.kind === "text")?.text ?? "";
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
