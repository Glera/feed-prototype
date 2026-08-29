export interface OperatorPresentationEntryV1 {
  label: string;
  icon: string;
  tone: string;
}

export interface OperatorPresentationVocabularyV1 {
  schema: 'platform.operator-presentation-vocabulary.v1';
  audience: Record<'labs' | 'exactUser' | 'team' | 'public', OperatorPresentationEntryV1>;
  workState: Record<
    'working' | 'ready' | 'needsHelp' | 'previousStopped',
    OperatorPresentationEntryV1
  >;
}

export interface PlatformDevelopmentIntakePresentationV1 {
  visible: boolean;
  state?: 'working' | 'ready' | 'needsHelp';
  label?: string;
  icon?: string;
  tone?: string;
  detail?: string;
  blocker?: string | null;
}

export function resolveOperatorPresentationVocabulary(
  value: unknown,
): Readonly<OperatorPresentationVocabularyV1>;
export function operatorAudiencePresentation(
  vocabulary: unknown,
  key: 'labs' | 'exactUser' | 'team' | 'public',
): Readonly<OperatorPresentationEntryV1>;
export function operatorWorkStatePresentation(
  vocabulary: unknown,
  key: 'working' | 'ready' | 'needsHelp' | 'previousStopped',
): Readonly<OperatorPresentationEntryV1>;
export function platformDevelopmentIntakePresentation(
  receipt: unknown,
  vocabulary: unknown,
): Readonly<PlatformDevelopmentIntakePresentationV1> | null;
