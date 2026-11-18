<script setup lang="ts">
import { onMounted } from "vue";
import { useWorkspace } from "./useWorkspace";
import StageRail from "./components/StageRail.vue";
import PlanStage from "./components/PlanStage.vue";
import CodeStage from "./components/CodeStage.vue";
import TestsPanel from "./components/TestsPanel.vue";
import DeliverPanel from "./components/DeliverPanel.vue";
import FindingsPanel from "./components/FindingsPanel.vue";
import CoachPanel from "./components/CoachPanel.vue";

const projectId = new URLSearchParams(location.search).get("id") || "";
const {
  project,
  stages,
  stage,
  stageLabel,
  stageHint,
  editorHint,
  isLastStage,
  currentPath,
  content,
  dirty,
  analyzing,
  findings,
  tests,
  testsLoaded,
  deliverable,
  deliverableLoaded,
  error,
  messages,
  citeCount,
  image,
  imageName,
  boot,
  goStage,
  advance,
  selectFile,
  markDirty,
  saveFile,
  addFile,
  deleteFile,
  analyze,
  updateFinding,
  saveGoal,
  addTest,
  updateTest,
  deleteTest,
  sendCoach,
  applySuggestion,
  undoLast,
  askStage,
  setImage,
  clearImage,
} = useWorkspace(projectId);

onMounted(boot);
</script>

<template>
  <template v-if="project">
    <StageRail :stages="stages" :current="stage" @select="goStage($event)" />

    <section class="stage-main">
      <div class="stage-head">
        <h2 id="stage-title">{{ stageLabel }}</h2>
        <span class="grow"></span>
        <button class="btn btn-sm btn-ghost" type="button" id="ask-stage" @click="askStage">AI 看这一步</button>
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          id="advance"
          v-show="!isLastStage"
          @click="advance"
        >
          完成本阶段 → 下一道
        </button>
      </div>
      <div class="stage-body" id="stage-body">
        <PlanStage v-if="stage === 'plan'" :goal="project.goal || ''" @save="saveGoal" />

        <template v-else>
          <DeliverPanel
            v-if="stage === 'deliver'"
            :data="deliverable"
            :loaded="deliverableLoaded"
          />
          <TestsPanel
            v-if="stage === 'test'"
            :tests="tests"
            :loaded="testsLoaded"
            @add="addTest"
            @update="updateTest"
            @remove="deleteTest"
          />
          <p v-if="stageHint" class="code-hint" style="margin: 0 0 10px;">{{ stageHint }}</p>
          <CodeStage
            :files="project.files"
            :current-path="currentPath"
            :model-value="content"
            :hint="editorHint"
            :dirty="dirty"
            :analyzing="analyzing"
            @select="selectFile"
            @update:model-value="markDirty"
            @add="addFile"
            @save="saveFile"
            @remove="deleteFile"
            @analyze="analyze"
          />
        </template>
      </div>
    </section>

    <aside class="assist-side">
      <FindingsPanel :findings="findings" @update="updateFinding" />
      <CoachPanel
        :messages="messages"
        :image="image"
        :image-name="imageName"
        :cite-count="citeCount"
        @send="sendCoach"
        @image-change="setImage"
        @image-clear="clearImage"
        @apply="applySuggestion"
        @undo="undoLast"
      />
    </aside>
  </template>

  <main v-else-if="error" class="assist-page">
    <div class="assist-empty">
      {{ error }}<br />
      <a href="../">回到辅助开发</a>
    </div>
  </main>
</template>