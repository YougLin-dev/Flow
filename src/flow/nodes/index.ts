/**
 * The nodes area facade: the node kinds, their ports and settings, and the
 * model catalogs. The registry is a leaf module; this surface has no runtime
 * dependencies of its own.
 */
export {
  canConnectPorts,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_TEXT_MODEL,
  defaultSettings,
  hasImageOutput,
  IMAGE_ASPECTS,
  IMAGE_MODELS,
  IMAGE_RESOLUTIONS,
  imageModelLabel,
  isImageModel,
  isKnownKind,
  isPortKind,
  isRunnableKind,
  isTextModel,
  nodeKind,
  parseSettings,
  PORT_KINDS,
  portsOfNode,
  serializeSettings,
  statusLabel,
  TEXT_MODELS,
  textModelLabel,
} from "./node-kinds";
export type {
  FlowAccent,
  ImageAspect,
  ImageModelId,
  ImageResolution,
  ImageSettings,
  InputPort,
  NodeKindId,
  NodeSettings,
  OutputPort,
  PortKind,
  TextModelId,
  TextSettings,
  UploadSettings,
} from "./node-kinds";
