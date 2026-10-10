import { lazy, Suspense, type ComponentProps } from 'react';

// Track C4: the game pages' insight blocks load as their own chunk (the main bundle stays lean for first paint).
const load = () => import('./index');
const GameInsightsLazy = lazy(() => load().then((m) => ({ default: m.GameInsights })));
const DiscoverInsightsLazy = lazy(() => load().then((m) => ({ default: m.DiscoverInsights })));
const CommunityTagsLazy = lazy(() => load().then((m) => ({ default: m.CommunityTags })));
const FranchiseTimelineLazy = lazy(() => load().then((m) => ({ default: m.FranchiseTimeline })));

type M = typeof import('./index');

export const GameInsights = (p: ComponentProps<M['GameInsights']>) => <Suspense fallback={<div style={{ minHeight: 180 }} aria-busy="true" />}><GameInsightsLazy {...p} /></Suspense>;
export const DiscoverInsights = (p: ComponentProps<M['DiscoverInsights']>) => <Suspense fallback={<div style={{ minHeight: 180 }} aria-busy="true" />}><DiscoverInsightsLazy {...p} /></Suspense>;
export const CommunityTags = (p: ComponentProps<M['CommunityTags']>) => <Suspense fallback={null}><CommunityTagsLazy {...p} /></Suspense>;
export const FranchiseTimeline = (p: ComponentProps<M['FranchiseTimeline']>) => <Suspense fallback={null}><FranchiseTimelineLazy {...p} /></Suspense>;
