// 应用版本号唯一来源：package.json 的 version 字段。
// 发版只改 package.json，侧边栏/设置页等界面显示全部跟随这里
import pkg from '../../package.json'

export const APP_VERSION: string = pkg.version
