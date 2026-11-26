// Whether what's rendered sits in a floating plugin's window (Floating.tsx), where a node like the
// conversation drops its own frame and spacing to fit the smaller window.
import { createContext } from "react";

export const FloatingSurface = createContext(false);
