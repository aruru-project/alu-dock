<script setup lang="ts">
import dockIconUrl from '../../../../assets/icon.svg'
</script>

<!-- Shown instead of the App when a production build is opened outside the AluDock client. -->
<template>
  <main class="open-in-app">
    <div class="alu-welcome">
      <img :src="dockIconUrl" alt="Alu Dock" />
      <div class="alu-welcome-text">请在 AluDock 客户端中打开。</div>
    </div>
  </main>
</template>

<style scoped>
/* The shared welcome layer sits below its container, so the container starts its own stacking context. */
.open-in-app { position: relative; isolation: isolate; height: 100%; height: 100dvh; }
</style>
