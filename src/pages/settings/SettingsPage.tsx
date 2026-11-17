import { type JSX, signal, Text, View } from "nsh";
import { Button } from "nsh/base";
import { saveSettings } from "../../startup";
import { appSettings, setAppSettings, type StartupMode } from "../../store";

/**
 * The Settings window: app-level choices, kept in Storage. Startup decides
 * which window a managed root shows first; the Projects window is always a
 * command away.
 */
export function SettingsPage() {
  const saveError = signal(false);
  const choose = (startup: StartupMode): void => {
    setAppSettings({ startup });
    saveError.set(false);
    void saveSettings({ startup }).catch(() => saveError.set(true));
  };
  const option = (mode: StartupMode, title: string, detail: string): JSX.Element => (
    <Button
      testID={`startup-${mode}`}
      selected={appSettings().startup === mode}
      onPress={() => choose(mode)}
      class="items-start rounded-(--radius) border border-border bg-card px-4 py-3 text-left hover:bg-muted active:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
      classList={{ "border-accent bg-accent": appSettings().startup === mode }}
    >
      <View class="gap-1">
        <View class="flex-row items-center gap-2">
          <Text class="text-sm font-medium text-card-foreground">{title}</Text>
          {appSettings().startup === mode ? (
            <Text
              testID={`startup-check-${mode}`}
              class="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
            >
              Current
            </Text>
          ) : null}
        </View>
        <Text class="text-xs text-muted-foreground">{detail}</Text>
      </View>
    </Button>
  );
  return (
    <View testID="settings-page" class="min-h-0 flex-1 bg-background">
      <View class="mx-auto w-full max-w-xl gap-5 px-8 py-8">
        <View class="gap-1">
          <Text class="text-xl font-semibold text-foreground">Settings</Text>
          <Text class="text-sm text-muted-foreground">How Flow opens.</Text>
        </View>
        <View class="gap-2">
          <Text class="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            At startup
          </Text>
          {option("projects", "Show Projects", "Start with the project list.")}
          {option(
            "lastProject",
            "Open the last project",
            "Start in the project that was open when Flow last closed cleanly. If it can’t open, Projects shows instead.",
          )}
        </View>
        {saveError() ? (
          <Text testID="settings-save-error" class="text-xs text-destructive">
            Couldn’t save the setting. It will be used for this run only.
          </Text>
        ) : null}
      </View>
    </View>
  );
}
