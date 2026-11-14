/** One image load or failure, reported for the host image regression. */
export interface CardImageEvent {
  readonly nodeId: string;
  readonly kind: "load" | "error";
  readonly url: string;
  readonly width: number;
  readonly height: number;
  readonly message: string;
}
