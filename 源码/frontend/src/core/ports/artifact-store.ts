/**
 * 产物存取端口。同时管登记（库里一行）与落盘（工作区一个文件）。
 * 合成一个端口而不是拆两个：分开的话调用方忘了一步，就会出现有记录没文件这种最难查的不一致。
 */

import type { Artifact, ArtifactKind, NewArtifact } from "../domain/artifact";

export interface ArtifactStore {
  /** 写入并登记，返回登记后的记录 */
  save(
    data: Omit<NewArtifact, "bytes" | "sha256"> & { content: string },
  ): Promise<Artifact>;
  listByRun(runId: string): Promise<Artifact[]>;
  /** 取某次运行某类型的最新产物 */
  findLatest(runId: string, kind: ArtifactKind): Promise<Artifact | null>;
  /** 文件不存在时返回 null，不抛 */
  readContent(artifact: Artifact): Promise<string | null>;
  /** 文件与登记一起删 */
  removeByRun(runId: string): Promise<number>;
}
