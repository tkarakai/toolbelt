import type { ElectrobunConfig } from "electrobun";
import pkg from "./package.json";
export default {
  app:{name:"Toolbelt Plugin Tester",identifier:"io.github.tkarakai.toolbelt.tester",version:pkg.version},
  build:{buildFolder:"build-tester.noindex",mainProcess:"bun",bun:{entrypoint:"src/bun/tester.ts"},copy:{"dist-tester/index.html":"views/ui/index.html","dist-tester/assets":"views/ui/assets","assets/tray-icon-dev@2x.png":"views/assets/tray-icon-dev@2x.png"},mac:{bundleCEF:false,icons:"dev-icon.iconset"}},
  runtime:{exitOnLastWindowClosed:true},
} satisfies ElectrobunConfig;
