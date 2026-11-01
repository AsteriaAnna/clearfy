export type Theme = "pink" | "sage" | "blue";

export const THEMES: { id: Theme; label: string }[] = [
  { id: "pink", label: "雾粉" },
  { id: "sage", label: "鼠尾草" },
  { id: "blue", label: "雾蓝石墨" },
];

export function loadTheme(): Theme {
  return (localStorage.getItem("clarify.theme") as Theme) || "pink";
}
