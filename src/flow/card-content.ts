/**
 * A card's document fields as equality-gated values. A viewport read replaces
 * every visible card's node record; a binding that read the record directly
 * would submit the card's title, status and body again although nothing in
 * them changed, so a zoom or pan cost one whole-card update per card. Reading
 * these accessors instead wakes a binding only when its value really moves.
 */
import { type Accessor, computed } from "nsh";
import type { NodeSummary } from "@flow/native";
import { type FlowAccent, nodeKind, statusLabel } from "./node-kinds";

export class CardContent {
  readonly title: Accessor<string>;
  readonly body: Accessor<string>;
  /** The raw status (`"running"`, `"done"`, …), gated by value. */
  readonly status: Accessor<string>;
  /** The status as the card shows it, or `""` for none. */
  readonly statusText: Accessor<string>;
  readonly accent: Accessor<FlowAccent>;
  readonly image: Accessor<boolean>;

  constructor(node: () => NodeSummary) {
    this.title = computed(() => node().title);
    this.body = computed(() => node().body.trim());
    this.status = computed(() => node().status);
    this.statusText = computed(() => statusLabel(node().status));
    this.accent = computed(() => nodeKind(node().kind).accent);
    this.image = computed(() => node().kind === "image");
  }
}
