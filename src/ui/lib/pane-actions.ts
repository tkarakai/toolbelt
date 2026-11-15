import { createContext } from "react";

/** The right end of a plugin pane's header: renderers put pane-wide controls there (the
 * details drawer toggle). Null where a surface has no header (quick views, dialogs). */
export const PaneActionsContext = createContext<HTMLElement | null>(null);
