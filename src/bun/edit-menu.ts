/** Native editing roles are required by WKWebView for selection and clipboard shortcuts. */
export const EDIT_MENU={label:"Edit",submenu:[{role:"undo"},{role:"redo"},{type:"separator"},{role:"cut"},{role:"copy"},{role:"paste"},{role:"selectAll"}]} as const;
