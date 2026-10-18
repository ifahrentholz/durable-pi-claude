<script setup lang="ts">
// One tool call waiting for a person (this fork): what it does, and allow / always allow / deny.
import { ref } from "vue";
import { Check, ShieldCheck, ShieldPlus, X } from "lucide-vue-next";
import type { ApprovalItem } from "@sdk/approvals";
import { decideTool, deciding } from "../client/approvals";

const props = defineProps<{ item: ApprovalItem }>();
const note = ref("");
const noting = ref(false);
function deny() {
  if (!noting.value) return void (noting.value = true);
  void decideTool(props.item, "deny", note.value);
}
</script>

<template>
  <div class="job-approval tool-approval" role="group" aria-label="Tool approval" :data-approval="item.callId">
    <div><ShieldCheck :size="20" /><strong>Approve {{ item.tool }}?</strong></div>
    <pre class="tool-approval-what">{{ item.summary }}</pre>
    <p>
      The agent waits on a saved checkpoint: close the browser or restart the device and this request will still be
      here. Nothing runs until you decide.
    </p>
    <textarea
      v-if="noting"
      v-model="note"
      class="tool-approval-note"
      rows="2"
      placeholder="Optional note for the agent, e.g. what to do instead"
    />
    <div class="job-approval-buttons">
      <button class="primary small" :disabled="!!deciding" @click="decideTool(item, 'allow')">
        <Check :size="18" />Allow once
      </button>
      <button
        v-if="item.rules.length"
        class="secondary"
        :disabled="!!deciding"
        :title="`Adds the rule ${item.rules.join(', ')} for this session`"
        @click="decideTool(item, 'always')"
      >
        <ShieldPlus :size="16" />Always allow <code>{{ item.rules.join(", ") }}</code>
      </button>
      <button class="secondary danger" :disabled="!!deciding" @click="deny">
        <X :size="16" />{{ noting ? "Deny with note" : "Deny" }}
      </button>
    </div>
  </div>
</template>
