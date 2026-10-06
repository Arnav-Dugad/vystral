// Track Q: a game's Steam Input layout (read-only). Mirror of src/Vystral.Core/Controller/SteamInputLayout.cs.

export type ControlId =
  | 'a' | 'b' | 'x' | 'y' | 'lb' | 'rb' | 'lt' | 'rt' | 'ls' | 'lsClick' | 'rs' | 'rsClick'
  | 'dpadUp' | 'dpadDown' | 'dpadLeft' | 'dpadRight' | 'view' | 'menu' | 'share' | 'guide'
  | 'p1' | 'p2' | 'p3' | 'p4' | 'leftPad' | 'rightPad' | 'centerPad' | 'gyro';

export type BindingActivator = 'press' | 'long' | 'double' | 'start' | 'release' | 'soft' | 'chord' | 'turbo' | 'analog' | 'modeshift' | 'other';
export type BindingKind = 'key' | 'mouse' | 'gamepad' | 'action' | 'system' | 'set' | 'layer' | 'mode' | 'other';

export interface ControllerBinding {
  activator: BindingActivator;
  /** Where on the control: null (the control itself), up/down/left/right, click, outer. */
  slot: string | null;
  /** The config's own name for it when it has one ("Jump"), else the output ("Space"). */
  label: string;
  /** The output in plain words when `label` is a custom name. */
  detail: string | null;
  kind: BindingKind;
}

export interface ControllerControl {
  control: ControlId;
  /** How an analog control behaves ("Mouse", "Camera", "Joystick"). */
  mode: string | null;
  bindings: ControllerBinding[];
  /** On a layer view: the layer changes this control. */
  fromLayer: boolean;
}

export interface ControllerSet {
  id: string;
  name: string;
  kind: 'set' | 'layer';
  parentId: string | null;
  controls: ControllerControl[];
}

/** steamInput: a layout was found; none: Steam has none for this game (it uses its own controller support). */
export type ControllerLayoutStatus = 'steamInput' | 'none' | 'notSteam' | 'noSteam' | 'unreadable';

export interface ControllerLayout {
  status: ControllerLayoutStatus;
  title: string | null;
  description: string | null;
  controllerType: string | null;
  controllerLabel: string | null;
  /** personal: your own edits; template: one of Steam's templates; workshop: a downloaded community or official layout. */
  sourceKind: 'personal' | 'template' | 'workshop' | null;
  templateName: string | null;
  sets: ControllerSet[];
  note: string | null;
}
