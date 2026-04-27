import { createMemo } from "solid-js"
import { DialogSelect } from "@tui/ui/dialog-select"
import { useDialog } from "@tui/ui/dialog"
import { useTag } from "@tui/context/tag"
import { useTheme } from "@tui/context/theme"
import path from "path"

export function DialogTag() {
  const dialog = useDialog()
  const tag = useTag()
  const { theme } = useTheme()

  const options = createMemo(() =>
    tag.tags.map((t) => {
      const selected = tag.isSelected(t.key)
      return {
        value: t.key,
        title: t.name,
        description: t.description || undefined,
        // Group by filename so related tags are listed together.
        category: path.basename(t.filename),
        gutter: (
          <text fg={selected ? theme.primary : theme.textMuted}>{selected ? "●" : "○"}</text>
        ),
      }
    }),
  )

  return (
    <DialogSelect
      title={`Select Tags  ${tag.selectedCount() > 0 ? `(${tag.selectedCount()} selected)` : ""}`}
      placeholder="Filter tags..."
      options={options()}
      // Space toggles without closing; Enter also toggles (dialog stays open for multi-select).
      keybind={[
        {
          title: "toggle",
          keybind: {
            name: "space",
            ctrl: false,
            meta: false,
            shift: false,
            super: false,
            leader: false,
          },
          onTrigger: (option) => {
            tag.toggle(option.value)
          },
        },
      ]}
      onSelect={(option) => {
        tag.toggle(option.value)
        // Stay open so the user can select multiple tags.
        // Close via esc when done.
      }}
    />
  )
}
