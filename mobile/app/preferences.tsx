import { router } from 'expo-router'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useState } from 'react'
import { PrimaryButton } from '@/components/PrimaryButton'
import { StepSlider } from '@/components/StepSlider'
import { colors, radius } from '@/constants/theme'
import { useRoute } from '@/context/RouteContext'
import type { Preference, TimeConstraint } from '@/types/route'

const chips: Array<{ label: string; icon: string; value: Preference }> = [
  { label: '景色', icon: '🏞️', value: 'scenic' },
  { label: '海沿い', icon: '🌊', value: 'ocean' },
  { label: '夜景', icon: '🌃', value: 'night_view' },
  { label: '山道', icon: '⛰️', value: 'mountain' },
  { label: 'カフェ', icon: '☕', value: 'cafe' },
  { label: 'グルメ', icon: '🍜', value: 'gourmet' },
  { label: '温泉', icon: '♨️', value: 'hot_spring' },
  { label: '寄り道', icon: '🧭', value: 'detour' },
  { label: '静かな場所', icon: '🌿', value: 'quiet' },
]

/** 寄り道に使える分。null は制限なし(サーバは extra_time に0分を受け付けないので、最小は15分) */
const steps: Array<number | null> = [15, 30, 45, 60, 90, 120, null]
const stepLabels = ['15分', '30分', '45分', '1時間', '1.5時間', '2時間', '制限なし']

function initialStep(constraint: TimeConstraint, baseMinutes: number | undefined) {
  if (constraint.type === 'none') return steps.length - 1
  const extra = constraint.type === 'extra_time' ? constraint.minutes : constraint.minutes - (baseMinutes ?? 0)
  let best = 0
  steps.forEach((value, i) => {
    if (value !== null && Math.abs(value - extra) < Math.abs((steps[best] ?? 0) - extra)) best = i
  })
  return best
}

function formatDuration(minutes: number) {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}分`
  return m === 0 ? `${h}時間` : `${h}時間${m}分`
}

function formatClock(date: Date) {
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, '0')}`
}

export default function PreferencesScreen() {
  const route = useRoute()
  const baseMinutes = route.preview?.normalRoute.durationMinutes
  const [selected, setSelected] = useState<Preference[]>(route.preferences)
  const [step, setStep] = useState(() => initialStep(route.timeConstraint, baseMinutes))
  const [freeText, setFreeText] = useState(route.freeText)
  const [freeOpen, setFreeOpen] = useState(route.freeText.length > 0)

  const extra = steps[step]
  const timeConstraint: TimeConstraint = extra === null ? { type: 'none' } : { type: 'extra_time', minutes: extra }
  const totalMinutes = baseMinutes !== undefined && extra !== null ? baseMinutes + extra : undefined
  const arrival = totalMinutes !== undefined ? formatClock(new Date(Date.now() + totalMinutes * 60_000)) : null

  const toggle = (chip: Preference) => setSelected((current) =>
    current.includes(chip) ? current.filter((item) => item !== chip) : [...current, chip],
  )
  const moodSummary = selected.length === 0 ? 'おまかせ' : selected.map((value) => chips.find((chip) => chip.value === value)?.label).join('・')

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        <Pressable accessibilityRole="button" accessibilityLabel="戻る" onPress={() => router.back()} style={styles.backButton}>
          <Text style={styles.backIcon}>‹</Text>
        </Pressable>
        <Text style={styles.routeLabel}>
          {route.preview?.origin.name} → {route.preview?.destination.name}
          {baseMinutes !== undefined ? `・通常 約${baseMinutes}分` : ''}
        </Text>
        <Text style={styles.title}>どんな移動にしたい？</Text>

        <View style={styles.timeCard}>
          <View style={styles.timeTop}>
            <View>
              <Text style={styles.timeKey}>寄り道に使える時間</Text>
              <Text style={styles.timeBig}>{extra === null ? '制限なし' : `+${formatDuration(extra)}`}</Text>
            </View>
            <View style={styles.arrival}>
              <Text style={styles.timeKey}>到着の目安</Text>
              <Text style={styles.arrivalClock}>{arrival ?? '—'}</Text>
            </View>
          </View>

          <StepSlider labels={stepLabels} index={step} onChange={setStep} />

          {baseMinutes !== undefined ? (
            <View style={styles.bar}>
              <View style={[styles.barDrive, { flex: baseMinutes }]}>
                <Text numberOfLines={1} style={styles.barDriveText}>運転 {formatDuration(baseMinutes)}</Text>
              </View>
              <View style={[styles.barExtra, { flex: extra ?? baseMinutes }]}>
                <Text numberOfLines={1} style={styles.barExtraText}>{extra === null ? '寄り道 おまかせ' : `寄り道 ${formatDuration(extra)}`}</Text>
              </View>
            </View>
          ) : null}
        </View>

        <View style={styles.sectionHead}>
          <Text style={styles.sectionTitle}>気分</Text>
          <Text style={styles.help}>選ばなくてもOK・複数可</Text>
        </View>
        <View style={styles.grid}>
          {chips.map((chip) => {
            const active = selected.includes(chip.value)
            return (
              <Pressable
                key={chip.value}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: active }}
                onPress={() => toggle(chip.value)}
                style={[styles.mood, active && styles.activeMood]}
              >
                <Text style={styles.moodIcon}>{chip.icon}</Text>
                <Text style={[styles.moodText, active && styles.activeMoodText]}>{chip.label}</Text>
              </Pressable>
            )
          })}
        </View>

        {freeOpen ? (
          <TextInput
            autoFocus={route.freeText.length === 0}
            multiline
            numberOfLines={3}
            maxLength={500}
            value={freeText}
            onChangeText={setFreeText}
            placeholder="例：海を見ながら休憩したい"
            placeholderTextColor="#CBD5E1"
            style={styles.input}
            textAlignVertical="top"
          />
        ) : (
          <Pressable accessibilityRole="button" onPress={() => setFreeOpen(true)} style={styles.freeClosed}>
            <Text style={styles.freeClosedText}>＋ 言葉でAIに伝える（例：海を見ながら休憩したい）</Text>
          </Pressable>
        )}
      </ScrollView>

      <View style={styles.footer}>
        <PrimaryButton onPress={() => {
          route.updatePreferences({ preferences: selected, freeText, timeConstraint })
          router.push('/generating')
        }}>AIでルートを作る</PrimaryButton>
        <Text style={styles.summary}>
          <Text style={styles.summaryStrong}>{moodSummary}</Text>
          {totalMinutes !== undefined ? ` ／ 合計 ${formatDuration(totalMinutes)}・` : ' ／ 時間の制限なし'}
          {arrival ? <Text style={styles.summaryStrong}>{arrival} 着</Text> : null}
        </Text>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.white },
  content: { flexGrow: 1, paddingHorizontal: 22, paddingTop: 16, paddingBottom: 24 },
  backButton: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#F1F5F9', alignItems: 'center', justifyContent: 'center' },
  backIcon: { color: colors.ink, fontSize: 30, lineHeight: 31 },
  routeLabel: { color: colors.faint, fontSize: 12, marginTop: 10 },
  title: { color: colors.ink, fontSize: 26, lineHeight: 34, fontWeight: '800', marginTop: 8 },
  timeCard: { marginTop: 16, borderWidth: 1, borderColor: colors.border, borderRadius: 18, backgroundColor: colors.surface, padding: 16, gap: 10 },
  timeTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end' },
  timeKey: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  timeBig: { color: colors.brandDark, fontSize: 30, lineHeight: 38, fontWeight: '800' },
  arrival: { alignItems: 'flex-end' },
  arrivalClock: { color: colors.ink, fontSize: 22, lineHeight: 30, fontWeight: '800' },
  bar: { flexDirection: 'row', height: 26, borderRadius: 8, overflow: 'hidden' },
  barDrive: { backgroundColor: '#CBD5E1', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4 },
  barDriveText: { color: colors.text, fontSize: 11, fontWeight: '700' },
  barExtra: { backgroundColor: colors.brandSoft, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 4, borderLeftWidth: 2, borderLeftColor: colors.brand },
  barExtraText: { color: colors.brandDark, fontSize: 11, fontWeight: '700' },
  sectionHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', marginTop: 22, marginBottom: 10 },
  sectionTitle: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  help: { color: colors.faint, fontSize: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  mood: { width: '31.8%', borderRadius: 14, backgroundColor: '#F1F5F9', paddingVertical: 10, alignItems: 'center', borderWidth: 2, borderColor: 'transparent' },
  activeMood: { backgroundColor: colors.brandSoft, borderColor: colors.brand },
  moodIcon: { fontSize: 22, lineHeight: 28 },
  moodText: { color: '#475569', fontSize: 13, fontWeight: '700' },
  activeMoodText: { color: colors.brandDark },
  freeClosed: { marginTop: 16, borderWidth: 1, borderStyle: 'dashed', borderColor: colors.border, borderRadius: 14, paddingHorizontal: 14, paddingVertical: 12 },
  freeClosedText: { color: colors.muted, fontSize: 13 },
  input: { marginTop: 16, minHeight: 80, borderWidth: 1, borderColor: colors.border, borderRadius: radius.large, backgroundColor: colors.surface, color: colors.ink, fontSize: 14, padding: 14 },
  footer: { paddingHorizontal: 22, paddingTop: 12, paddingBottom: 16, gap: 8, borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.white },
  summary: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  summaryStrong: { color: colors.ink, fontWeight: '700' },
})
