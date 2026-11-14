/**
 * The model picker both composers' sheets share: the current model's name and
 * a chevron, opening the kind's models above the trigger. The caller validates
 * the chosen id, because each kind has its own catalog.
 */
import { Text, token } from "nsh";
import { Button, Select } from "nsh/base";
import { ChevronDown } from "lucide";
import { Icon } from "./Icon";

/** One choice in a kind's model catalog. */
export interface ComposerModel {
  readonly id: string;
  readonly label: string;
}

export interface ComposerModelSelectProps {
  readonly accessibilityLabel: string;
  readonly value: string;
  readonly label: string;
  readonly models: readonly ComposerModel[];
  readonly onChange: (id: string) => void;
}

/** The composer's model picker, showing the current model's name. */
export function ComposerModelSelect(props: ComposerModelSelectProps) {
  return (
    <Select
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      items={props.models.map((model) => ({ value: model.id, title: model.label }))}
      onChange={(event) => {
        if (event.value !== null) props.onChange(event.value);
      }}
      placement="top"
      align="start"
      offset={8}
      popupClass="rounded-xl border border-border bg-popover p-1 shadow-lg"
      popupStyle={{ width: 180 }}
      itemClass="rounded-md px-2 py-1 text-xs text-popover-foreground focus:bg-accent selected:bg-muted"
      trigger={
        <Button
          testID="composer-model"
          accessibilityLabel={props.accessibilityLabel}
          class="flex-row items-center gap-0.5 rounded-md px-1 py-1 text-xs text-card-foreground hover:bg-accent active:bg-muted"
          style={{ maxWidth: 130 }}
        >
          <Text class="text-xs" style={{ numberOfLines: 1, textOverflow: "ellipsis" }}>
            {props.label}
          </Text>
          <Icon icon={ChevronDown} size={12} tint={() => token("muted-foreground")} />
        </Button>
      }
    />
  );
}
