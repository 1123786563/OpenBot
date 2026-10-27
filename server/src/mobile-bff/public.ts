// server/src/mobile-bff/public.ts
// MOD21（Issue #641，根 #620）：mobile-bff 的公开出口（provisioner 面）。
//
// 纯 re-export、零逻辑、零判定：跨模块消费面（M03 openmuse-template-store）
// 只取这七个符号，恰消费所需符号（宁可小不可造）。路由装配（assembly）与
// 组内消费照旧直取内件，不经本出口。
export {
  OPENMUSE_TEMPLATE_KEY,
  OPENMUSE_TEMPLATE_VERSION,
  isUniqueViolation,
  openMuseTemplateV1,
} from "./openmuse-bot";
export type {
  OpenMuseTemplateStore,
  OpenMuseTemplateV1,
  StoredTemplateProfile,
} from "./openmuse-bot";
