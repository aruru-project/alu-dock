<script setup lang="ts">
import type { ReadonlyRefs } from '../lib/ownerView'
import { Link } from '@lucide/vue'
import { DEVICE_NAME_FALLBACK } from '../lib/deviceName'
import type { useHostConnection } from '../lib/hostConnection'
import LocalConnectionCard from './LocalConnectionCard.vue'
import dockIconUrl from '../../../../assets/icon.svg'
import { useAppStore } from '../stores/app'

const props = defineProps<{
  host: ReadonlyRefs<Pick<ReturnType<typeof useHostConnection>, 'beginPairing' | 'connectLocal' | 'discardRecoveredPairing' | 'pairingError' | 'pairingMessage' | 'pairingPin' | 'pairingStage' | 'pairingTransactionId' | 'recoverablePairings' | 'rememberPairDeviceName' | 'resumeRecoveredPairing' | 'stopPairing' | 'updateLocalEndpoint'>> & Pick<ReturnType<typeof useHostConnection>, 'pairDeviceName' | 'pairHost' | 'pairPort'>
  busy: boolean
}>()
const app = useAppStore()
const { pairHost, pairPort, pairDeviceName, pairingTransactionId, pairingStage, pairingPin, pairingMessage, pairingError, recoverablePairings, rememberPairDeviceName, beginPairing, resumeRecoveredPairing, discardRecoveredPairing, stopPairing, connectLocal, updateLocalEndpoint } = props.host
</script>

<template>
    <div class="pairing-onboarding">
      <div class="pairing-intro">
        <img :src="dockIconUrl" alt="Alu Dock" />
        <div><span class="eyebrow">WELCOME TO ALUDOCK</span><h1>连接你的 AluDock</h1><p>连接这台设备上的 AluDock，或通过配对连接其他电脑。</p></div>
      </div>
      <div class="pairing-layout">
        <form class="pairing-card" @submit.prevent="beginPairing()">
          <LocalConnectionCard
            v-if="app.catalog?.localConnectionSupported"
            :connected="!!app.localSelected"
            :effective-endpoint="app.catalog.localEndpointEffective"
            :endpoint-override="app.catalog.localEndpointOverride"
            :busy="app.loading || props.busy"
            :error="app.error"
            @connect="connectLocal"
            @save="updateLocalEndpoint"
          />
          <div v-if="app.catalog?.localConnectionSupported" class="pairing-method-divider"><span>或通过配对连接其他电脑</span></div>
          <div class="pairing-card-title"><Link :size="18" /><div><strong>电脑连接信息</strong><small>地址只用于找到电脑，配对后会单独验证 Host 身份</small></div></div>
          <section v-if="recoverablePairings.length" class="pairing-recovery" aria-label="可恢复配对">
            <strong>可恢复的配对</strong><small>地址和设备名称已安全保存，不需要重新输入。</small>
            <article v-for="transaction in recoverablePairings" :key="transaction.transactionId">
              <span><b>{{ transaction.deviceName || DEVICE_NAME_FALLBACK }}</b><code>{{ transaction.host && transaction.port ? `${transaction.host}:${transaction.port}` : '旧版配对信息' }}</code></span>
              <div><button v-if="pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button><button v-else type="button" class="button secondary" :disabled="!transaction.recoverable" @click="resumeRecoveredPairing(transaction.transactionId)">恢复</button><button type="button" class="button secondary" :disabled="pairingTransactionId === transaction.transactionId && !['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" @click="discardRecoveredPairing(transaction.transactionId)">丢弃</button></div>
            </article>
          </section>
          <label><span>IP 地址或域名</span><input v-model="pairHost" autocomplete="off" spellcheck="false" placeholder="例如 192.168.1.20 或 dock.example.com" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
          <label><span>端口</span><input v-model.number="pairPort" type="number" inputmode="numeric" min="1" max="65535" placeholder="从电脑端 AluDock 查看" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" /></label>
          <label><span>这台设备的名称</span><input v-model="pairDeviceName" maxlength="128" required autocomplete="off" placeholder="例如 NUC14 或我的 MacBook" :disabled="!['idle', 'failed', 'cancelled'].includes(pairingStage)" @input="rememberPairDeviceName" /><small class="pairing-field-hint">显示在电脑端；修改后会在重新配对时沿用。</small></label>
          <div v-if="pairingPin" class="pairing-pin"><small>请在电脑上的 AluDock 中输入</small><strong>{{ pairingPin }}</strong><span>不要把配对码发给其他人</span></div>
          <div v-if="pairingMessage" class="pairing-progress"><span class="alu-spinner" />{{ pairingMessage }}</div>
          <div v-if="pairingError || app.error" class="directory-error">{{ pairingError || app.error }}</div>
          <div class="pairing-actions">
            <button v-if="!['idle', 'failed', 'cancelled', 'completed'].includes(pairingStage)" type="button" class="button secondary" @click="stopPairing">取消</button>
            <button v-else type="submit" class="button primary" :disabled="!pairHost.trim() || !pairPort || !pairDeviceName.trim()">{{ pairingStage === 'failed' ? '重新尝试' : '开始配对' }}</button>
          </div>
        </form>
        <ol class="pairing-guide">
          <li><span>1</span><div><strong>在电脑上打开 AluDock</strong><p>进入 Remote Access / 配对，并打开五分钟配对窗口。</p></div></li>
          <li><span>2</span><div><strong>填写电脑地址与端口</strong><p>在家中通常填写局域网 IP；配对后还能为同一 Host 添加外网域名。</p></div></li>
          <li><span>3</span><div><strong>把四位码输入电脑端</strong><p>客户端会继续验证安全连接，确认完成后自动进入 Work 列表。</p></div></li>
        </ol>
      </div>
    </div>

</template>
