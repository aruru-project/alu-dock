import { isLiveTurnId, liveTurnId } from './conversation'
import { turnLanded } from './conversationPresentation'
import type { ProjectedEvent } from './types'

/** A turn's output speed changed: a new value, or none when the turn can no longer be measured. */
export interface TurnSpeedChange { turnId: string; tokensPerSecond?: number }

/** Shorter generation than this reads as noise, not as a provider's speed. */
const MIN_GENERATION_MS = 1000

interface MeasuredTurn {
  turnId: string
  baselineOutput: number
  generationMs: number
  outputStartedAt?: number
  toolCalls: Set<string>
  settled: boolean
}

/**
 * Output speed of each run this client watched from its start: output tokens the
 * run added (the session total reported by the Host) divided by the time the
 * model was producing output. A model call counts from its first streamed output
 * (text, thinking or tool arguments) to its completed message; tool execution
 * between calls does not count. Event times are the Host's, not this device's.
 *
 * `previousSequence` is the Work's event position before this event. When it is
 * not the last event fed here, something was skipped (another read, a gap while
 * away) and the running turn is dropped rather than guessed.
 */
export function createTurnSpeedMeter() {
  let lastSequence: number | undefined
  let turn: MeasuredTurn | undefined

  function drop(): TurnSpeedChange | undefined {
    const dropped = turn
    turn = undefined
    return dropped && !dropped.settled ? { turnId: dropped.turnId } : undefined
  }

  function apply(event: ProjectedEvent, previousSequence: number, outputTokens: number | undefined): TurnSpeedChange | undefined {
    const continuous = lastSequence === previousSequence
    lastSequence = event.sequence
    const at = Date.parse(event.occurredAt)
    if (event.eventType === 'run.started') {
      drop()
      turn = outputTokens === undefined || !Number.isFinite(at) ? undefined
        : { turnId: liveTurnId(event.sequence), baselineOutput: outputTokens, generationMs: 0, toolCalls: new Set(), settled: false }
      return undefined
    }
    if (!turn) return undefined
    if (!continuous || !Number.isFinite(at)) return drop()
    const data = event.data
    switch (event.eventType) {
      case 'compaction.started':
      case 'compaction.completed':
        // A summary's tokens would count as this run's output.
        return drop()
      case 'message.delta':
        if (!turn.settled) turn.outputStartedAt ??= at
        return undefined
      case 'tool.started':
      case 'tool.args_updated': {
        // The same events report execution; only a call not seen before is the model
        // writing it. Calls made by a running tool carry their parent's id before `/`.
        const id = String(data.toolCallId ?? '')
        if (turn.settled || !id || id.includes('/') || turn.toolCalls.has(id)) return undefined
        turn.toolCalls.add(id)
        turn.outputStartedAt ??= at
        return undefined
      }
      // The token total and the completed reply can arrive in either order, so both
      // recompute; the last reply's tokens can also be reported after the run settles.
      case 'message.completed':
        if (data.role !== 'assistant') return undefined
        closeOutput(turn, at)
        return sample(turn, outputTokens)
      case 'run.settled':
        closeOutput(turn, at)
        turn.settled = true
        return sample(turn, outputTokens)
      case 'session.metrics_changed':
        return outputTokens === undefined ? drop() : sample(turn, outputTokens)
      default:
        return undefined
    }
  }

  function sample(measured: MeasuredTurn, outputTokens: number | undefined): TurnSpeedChange | undefined {
    // Only finished model calls count; an open one has tokens not yet reported.
    if (outputTokens === undefined || measured.outputStartedAt !== undefined) return undefined
    const tokens = outputTokens - measured.baselineOutput
    if (tokens <= 0 || measured.generationMs < MIN_GENERATION_MS) return undefined
    return { turnId: measured.turnId, tokensPerSecond: tokens / (measured.generationMs / 1000) }
  }

  return { apply }
}

function closeOutput(turn: MeasuredTurn, at: number) {
  if (turn.outputStartedAt === undefined) return
  turn.generationMs += Math.max(0, at - turn.outputStartedAt)
  turn.outputStartedAt = undefined
}

/** A live turn that history now shows under its own id at the same position. */
export function turnsHandedOff(before: readonly string[], after: readonly string[]): Array<[live: string, history: string]> {
  const moved: Array<[string, string]> = []
  for (const id of before) {
    if (!isLiveTurnId(id) || after.includes(id)) continue
    const successor = turnLanded(id, before, after)
    if (successor) moved.push([id, successor])
  }
  return moved
}

export function formatTurnSpeed(tokensPerSecond: number): string {
  return `${tokensPerSecond >= 10 ? Math.round(tokensPerSecond) : tokensPerSecond.toFixed(1)} tok/s`
}
