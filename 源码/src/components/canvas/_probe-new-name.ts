// 探针：测一个从没用过的文件名能不能写进去。
// 如果能，说明 EIO 是"按路径"的（harness 缓存了旧状态），
// 换个名字就能绕开。
export const PROBE = true;