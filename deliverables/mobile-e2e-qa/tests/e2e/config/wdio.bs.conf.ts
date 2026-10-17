// config/wdio.bs.conf.ts —— BrowserStack 云真机（CI 夜间矩阵）
import { config } from "./shared.conf";

const bsUser = process.env.BSTACK_USER;
const bsKey = process.env.BSTACK_KEY;

export const configBs = {
  ...config,
  user: bsUser,
  key: bsKey,
  services: [["browserstack", { browserstackLocal: true }]],
  capabilities: [
    {
      "bstack:options": {
        projectName: "mobile-app-e2e",
        buildName: `nightly-${process.env.GITHUB_RUN_ID ?? "local"}`,
        sessionName: process.env.BS_SESSION_NAME ?? "e2e-matrix",
        appiumVersion: "2.11",
        // 机型由 CI 矩阵注入
        deviceName: process.env.BS_DEVICE ?? "Samsung Galaxy S23",
        osVersion: process.env.BS_OS_VERSION ?? "13.0",
        app: process.env.BSTACK_APP_ID, // 提前上传的 build hash
        realMobile: true,
        video: true, // 云端录屏
        networkLogs: true, // 排查弱网用例
      },
      platformName: "android", // 由矩阵覆盖
    },
  ],
};
