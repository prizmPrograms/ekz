import { useState } from 'react'
import { StyleSheet, Text, View, type GestureResponderEvent } from 'react-native'
import { colors } from '@/constants/theme'

type Props = {
  labels: string[]
  index: number
  onChange: (index: number) => void
}

const KNOB = 26

/** 決まった段階だけを選ぶスライダー。ネイティブのモジュールを足さずに作る(アプリの再ビルドが要らない) */
export function StepSlider({ labels, index, onChange }: Props) {
  const [width, setWidth] = useState(0)
  const steps = labels.length - 1
  const usable = Math.max(width - KNOB, 1)
  const knobLeft = (index / steps) * usable

  const pick = (event: GestureResponderEvent) => {
    const ratio = (event.nativeEvent.locationX - KNOB / 2) / usable
    const next = Math.min(steps, Math.max(0, Math.round(ratio * steps)))
    if (next !== index) onChange(next)
  }

  return (
    <View>
      <View
        accessibilityRole="adjustable"
        accessibilityValue={{ text: labels[index] }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'increment') onChange(Math.min(steps, index + 1))
          if (event.nativeEvent.actionName === 'decrement') onChange(Math.max(0, index - 1))
        }}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={pick}
        onResponderMove={pick}
        style={styles.area}
      >
        <View pointerEvents="none" style={[styles.track, { left: KNOB / 2, right: KNOB / 2 }]} />
        <View pointerEvents="none" style={[styles.fill, { left: KNOB / 2, width: knobLeft }]} />
        <View pointerEvents="none" style={[styles.knob, { left: knobLeft }]} />
      </View>
      <View style={styles.ticks}>
        {labels.map((label, i) => (
          <Text
            key={label}
            onPress={() => onChange(i)}
            style={[styles.tick, i === index && styles.activeTick, { left: (i / steps) * usable + KNOB / 2 - 24 }]}
          >
            {label}
          </Text>
        ))}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  area: { height: 40, justifyContent: 'center' },
  track: { position: 'absolute', top: 18, height: 5, borderRadius: 3, backgroundColor: colors.border },
  fill: { position: 'absolute', top: 18, height: 5, borderRadius: 3, backgroundColor: colors.brand },
  knob: { position: 'absolute', top: 7, width: KNOB, height: KNOB, borderRadius: KNOB / 2, backgroundColor: colors.white, borderWidth: 3, borderColor: colors.brand, elevation: 3 },
  ticks: { height: 20 },
  tick: { position: 'absolute', width: 48, textAlign: 'center', fontSize: 11, color: colors.faint },
  activeTick: { color: colors.brandDark, fontWeight: '800' },
})
