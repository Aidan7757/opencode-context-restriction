import { createContext, onMount, onCleanup, useContext } from "solid-js"
import { createStore } from "solid-js/store"
import type { JSX } from "solid-js"
import { TagService, type Tag } from "@/tag/service"
import { useSync } from "@tui/context/sync"

type TagContextValue = {
  tags: Tag[]
  selected: string[]
  toggle: (name: string) => void
  setSelected: (names: string[]) => void
  isSelected: (name: string) => boolean
  selectedCount: () => number
}

const TagContext = createContext<TagContextValue>()

export function TagProvider(props: { children: JSX.Element }) {
  const sync = useSync()

  const [store, setStore] = createStore({
    tags: [] as Tag[],
    selected: [] as string[],
  })

  onMount(async () => {
    const dir = sync.data.path.directory || process.cwd()

    const unsubscribe = TagService.onChange(() => {
      setStore({
        tags: TagService.getAll(),
        selected: TagService.getSelected().map((t) => t.name),
      })
    })

    onCleanup(unsubscribe)

    await TagService.init(dir)
  })

  const value: TagContextValue = {
    get tags() {
      return store.tags
    },
    get selected() {
      return store.selected
    },
    toggle(name) {
      TagService.toggle(name)
    },
    setSelected(names) {
      TagService.setSelected(names)
    },
    isSelected(name) {
      return TagService.isSelected(name)
    },
    selectedCount() {
      return store.selected.length
    },
  }

  return <TagContext.Provider value={value}>{props.children}</TagContext.Provider>
}

export function useTag(): TagContextValue {
  const ctx = useContext(TagContext)
  if (!ctx) throw new Error("useTag must be used within TagProvider")
  return ctx
}
