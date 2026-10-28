// VOICE 的公开出口：M04（channels）消费所需的名字由此再导出，跨模块深取
// voice/cut.ts 视为越界（checker 对 public.ts 导入免计环边）。
export { openingOf } from "./cut";
