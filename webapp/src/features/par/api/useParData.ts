// Copyright (c) 2026 WSO2 LLC. (https://www.wso2.com).
//
// WSO2 LLC. licenses this file to you under the Apache License,
// Version 2.0 (the "License"); you may not use this file except
// in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing,
// software distributed under the License is distributed on an
// "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
// KIND, either express or implied.  See the License for the
// specific language governing permissions and limitations
// under the License.

import { useQuery } from "@tanstack/react-query";
import { useAsgardeo } from "@asgardeo/react";
import { authedGet, HttpError, defaultQueryRetry } from "@api/http";
import { useAccessToken } from "@hooks/useAccessToken";
import { parBackendUrl, parServiceUrls } from "@config/apiConfig";
import { digiopsHeaders } from "@features/my/util/digiopsHeaders";
import type { ParCycle, ParEmployeeInfo, ParRating } from "./types";
import { useParLeadEmployees, useParLegacyHistory } from "./useLeadHistory";

// GET par-app's own /employees/{workEmail} — carries `leadEmail`, the exact
// field OngoingCycleView.tsx gates its tab set on. Not people-app's
// `managerEmail`: the two don't reliably agree, so this fetches par-app's
// own field directly rather than assuming the equivalent from elsewhere.
export function useParEmployeeInfo(workEmail: string | undefined, enabled = true) {
  const { isSignedIn } = useAsgardeo();
  const getAccessToken = useAccessToken();
  const backendConfigured = Boolean(parBackendUrl);
  return useQuery<ParEmployeeInfo>({
    queryKey: ["par-employee-info", workEmail],
    enabled: enabled && isSignedIn && backendConfigured && Boolean(workEmail),
    queryFn: async () => {
      const accessToken = await getAccessToken();
      return authedGet<ParEmployeeInfo>(
        parServiceUrls.parEmployeeInfo(workEmail!),
        accessToken,
        digiopsHeaders(),
      );
    },
    staleTime: 5 * 60 * 1000,
    retry: defaultQueryRetry,
  });
}

/**
 * Whether the signed-in employee has a lead, per par-app's own `leadEmail`
 * — drives OngoingCycleView.tsx's tab-set gate; see ParGroupPage.tsx.
 *
 * Fails OPEN: true unless the fetch has actually succeeded and confirmed
 * `leadEmail === null`. This is a UX-only tab-visibility decision, not a
 * security boundary (each screen's own API calls enforce access
 * server-side), so a slow or failed fetch should never hide tabs from
 * someone who does have a lead.
 *
 * `isLoading` deliberately tracks only the caller's own profile fetch
 * (`workEmailLoading`), not this hook's own `info` query — that's what
 * makes the fail-open above work; a slow/failed lead lookup must never
 * read as "still loading" to `ParRequiresLeadRoute`, which renders `null`
 * while `isLoading` is true.
 */
export function useParHasLead(workEmail: string | undefined, workEmailLoading: boolean): { hasLead: boolean; isLoading: boolean } {
  const info = useParEmployeeInfo(workEmail);
  return {
    hasLead: !(info.isSuccess && info.data.leadEmail === null),
    isLoading: workEmailLoading,
  };
}

/**
 * Whether the signed-in employee should see the Lead Portal — par-app's own
 * `Role.TEAM_LEAD` gate on `/lead-portal` (route.ts), sourced from this same
 * `isTeamLead` field. Unlike useParHasLead, this fails CLOSED: hiding a nav
 * item from someone who isn't a lead has no downside, whereas showing it to
 * everyone while the lookup is in flight would flash an empty Lead Portal
 * for every non-lead on every load.
 *
 * Used both by the route guard (always enabled) and by SideRail's nav-item
 * gate, which passes `enabled` so this only fetches while People Ops is the
 * active perspective — same reasoning as useFinanceGate/useLeaveGate.
 */
export function useParIsTeamLead(workEmail: string | undefined, enabled = true) {
  const info = useParEmployeeInfo(workEmail, enabled);
  return {
    isTeamLead: info.isSuccess && info.data.isTeamLead,
    isLoading: info.isLoading,
    isError: info.isError,
    error: info.error,
    isFetching: info.isFetching,
    refetch: info.refetch,
  };
}

/**
 * Whether the signed-in employee should see the Lead Portal nav item.
 * isTeamLead is scoped to the active cycle (see ParEmployeeInfo), so this
 * ORs in the org-chart signal (GET /employees?leadEmail=) to keep it visible
 * once a lead's cycle closes — matching ParRequiresTeamLeadRoute, the route
 * guard that actually enforces access. Only fetches that fallback once
 * isTeamLead resolves false. Fails CLOSED while either is unresolved, same
 * as useParIsTeamLead alone.
 */
export function useParCanSeeLeadPortal(workEmail: string | undefined, enabled = true) {
  const employeeInfo = useParIsTeamLead(workEmail, enabled);
  const directReports = useParLeadEmployees(
    enabled && !employeeInfo.isLoading && !employeeInfo.isTeamLead ? workEmail : undefined,
  );
  return {
    canSee: employeeInfo.isTeamLead || (directReports.isSuccess && directReports.data.length > 0),
    isLoading: employeeInfo.isLoading || (!employeeInfo.isTeamLead && directReports.isLoading),
    // Exposed so callers needing distinct error UI for each fetch (e.g.
    // ParRequiresTeamLeadRoute) don't have to re-derive this same
    // loading-guarded fallback query themselves.
    employeeInfo,
    directReports,
  };
}

/**
 * Whether the signed-in employee currently has an OPEN par cycle — drives
 * ParGroupPage.tsx's tab-set gate down to just PAR History when there isn't
 * one, since every other tab (Employee Feedback, Request/Provide 360°, F2F)
 * only makes sense inside a running cycle.
 *
 * `isActive` fails OPEN, same reasoning as useParHasLead: true unless the
 * fetch has actually succeeded and come back with no OPEN cycles — a failed
 * fetch must never hide tabs that would otherwise be available. Unlike
 * useParHasLead, `isLoading` also waits on this hook's own query (not just
 * the caller's profile fetch): the fail-open default is only safe to hand a
 * route guard once the cycle check has actually settled (success or error),
 * otherwise a route can render its cycle-only children for one tick and
 * then yank them away the moment the query resolves to "no cycle".
 */
export function useParHasActiveCycle(
  workEmail: string | undefined,
  workEmailLoading: boolean,
): { isActive: boolean; isLoading: boolean } {
  const cycles = useActiveParCycle(workEmail);
  return {
    isActive: !(cycles.isSuccess && cycles.data.length === 0),
    isLoading: workEmailLoading || cycles.isLoading,
  };
}

/**
 * Whether the "PAR" item under Me should be shown at all.
 *
 * Legacy par-app never hides its own menu entry for anyone (it always shows
 * "Employee Portal"/"PAR History" and falls back to an empty state) — but an
 * intern with no active cycle and no record of any kind, real or legacy,
 * lands on a History tab with nothing legitimate behind it, which reads as
 * broken rather than as "nothing here for you yet". This intentionally
 * diverges from legacy for exactly that case.
 *
 * Scoped to interns specifically, not to emptiness alone: par-app's own
 * `employeeTypes` config keeps INTERNSHIP eligible for cycles (config.toml),
 * so an intern currently in one keeps seeing PAR exactly like everyone else
 * — only the genuinely-nothing-yet case hides the item.
 *
 * "Real (post-migration) history" is `useClosedParCycles`, not a
 * per-cycle rating scan: `GET /par-cycles?email=&status=CLOSED` is already
 * filtered server-side to cycles where THIS employee has a `hris_par_rating`
 * row (db_queries.bal's `... IN (SELECT par_cycle_id FROM hris_par_rating
 * WHERE par_employee_email = ...)`), the exact query legacy's own "My
 * History" tab (ParHistory.tsx) uses for its upfront "No data available".
 * One cheap, pre-filtered call — not the N+1 a naive "check every closed
 * cycle" scan would need.
 *
 * Fails OPEN (visible), same reasoning as useParHasLead: a UX-only
 * visibility decision must never hide the item from someone who does have
 * something to see just because a fetch hasn't landed yet. Both history
 * checks only fire once we already know it's an intern with no active cycle
 * — no extra request for anyone else.
 *
 * `employmentType` is compared case-insensitively against "internship". The
 * actual wire value is `"INTERNSHIP"` (uppercase): people-app's own
 * `/employees/{id}` and par-app both source this field from the SAME
 * `employment_type` master-data table via digiops-hr's shared `entity`
 * GraphQL service, whose own README documents the field's value set as
 * uppercase strings (`"PERMANENT" | "CONSULTANCY" | "INTERNSHIP" | ...`) —
 * matching par-app's own `employeeTypes` config.toml list. (An earlier
 * version of this comment cited title-case "Internship" from unrelated
 * services — ats/backend, career-vacancy-service, candidate-service — which
 * each define their own independent enum for candidate/offer workflows, not
 * the employment_type table this field actually reads from.) Comparing
 * case-insensitively means the exact casing doesn't matter either way.
 */
export function useParEmployeeItemVisible(
  workEmail: string | undefined,
  employmentType: string | undefined,
  workEmailLoading: boolean,
  enabled = true,
): { canSee: boolean; isLoading: boolean } {
  const isIntern = employmentType?.toLowerCase() === "internship";
  const { isActive, isLoading: isActiveLoading } = useParHasActiveCycle(
    enabled ? workEmail : undefined,
    workEmailLoading,
  );
  const checkHistory = enabled && isIntern && !isActiveLoading && !isActive;
  const legacyHistory = useParLegacyHistory(workEmail, checkHistory);
  const closedCycles = useClosedParCycles(workEmail, checkHistory);
  const hasNothingToShow =
    isIntern &&
    !isActive &&
    legacyHistory.isSuccess &&
    legacyHistory.data.length === 0 &&
    closedCycles.isSuccess &&
    closedCycles.data.length === 0;
  return {
    canSee: !hasNothingToShow,
    isLoading:
      enabled && (isActiveLoading || (checkHistory && (legacyHistory.isLoading || closedCycles.isLoading))),
  };
}

// Returns the caller's currently-OPEN par cycle (if any). Non-lead/non-admin
// callers can only query their own email; backend enforces that.
export function useActiveParCycle(workEmail: string | undefined) {
  const { isSignedIn } = useAsgardeo();
  const getAccessToken = useAccessToken();
  const backendConfigured = Boolean(parBackendUrl);
  return useQuery<ParCycle[]>({
    queryKey: ["par-cycles-open", workEmail],
    enabled: isSignedIn && backendConfigured && Boolean(workEmail),
    queryFn: async () => {
      const accessToken = await getAccessToken();
      return authedGet<ParCycle[]>(
        parServiceUrls.parCycles(workEmail!, "OPEN"),
        accessToken,
        digiopsHeaders(),
      );
    },
    staleTime: 5 * 60 * 1000,
    retry: defaultQueryRetry,
  });
}

// Returns the caller's ParRating record for a specific cycle. Only fires
// once we have a cycleId. A 404 from the backend means "no rating record
// exists yet for you in this cycle" — surface it as null, not an error.
//
// `enabled` lets a caller hold the request until it's wanted — the History
// tab uses this to fetch a past cycle's record only once its row is opened,
// rather than one request per row on load.
export function useParRating(
  parCycleId: number | undefined,
  workEmail: string | undefined,
  enabled = true,
) {
  const { isSignedIn } = useAsgardeo();
  const getAccessToken = useAccessToken();
  const backendConfigured = Boolean(parBackendUrl);
  return useQuery<ParRating | null>({
    queryKey: ["par-rating", parCycleId, workEmail],
    enabled:
      enabled && isSignedIn && backendConfigured && Boolean(parCycleId) && Boolean(workEmail),
    queryFn: async () => {
      const accessToken = await getAccessToken();
      try {
        return await authedGet<ParRating>(
          parServiceUrls.parRating(parCycleId!, workEmail!),
          accessToken,
          digiopsHeaders(),
        );
      } catch (e) {
        // Backend returns 404 when there's no rating record yet — treat
        // that as a valid "no data" case instead of an error.
        if (e instanceof HttpError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 5 * 60 * 1000,
    retry: defaultQueryRetry,
  });
}

// Returns the caller's CLOSED par cycles. Only fires when explicitly
// enabled (typically because the OPEN query came back empty and we want
// to fall back to the last completed cycle).
export function useClosedParCycles(workEmail: string | undefined, enabled: boolean) {
  const { isSignedIn } = useAsgardeo();
  const getAccessToken = useAccessToken();
  const backendConfigured = Boolean(parBackendUrl);
  return useQuery<ParCycle[]>({
    queryKey: ["par-cycles-closed", workEmail],
    enabled: enabled && isSignedIn && backendConfigured && Boolean(workEmail),
    queryFn: async () => {
      const accessToken = await getAccessToken();
      return authedGet<ParCycle[]>(
        parServiceUrls.parCycles(workEmail!, "CLOSED"),
        accessToken,
        digiopsHeaders(),
      );
    },
    // Historical cycles change rarely — 10 min stale window is fine.
    staleTime: 10 * 60 * 1000,
    retry: (failureCount, error) => {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500) return false;
      return failureCount < 1;
    },
  });
}

// Returns "the cycle to show" for the Performance & growth card:
// prefer any currently OPEN cycle; if none, fall back to the most-recent
// CLOSED one so the section is never empty just because a new cycle
// hasn't opened yet. Also reports whether the returned cycle is active
// or past so the UI can differentiate messaging.
export function useLatestReviewCycle(workEmail: string | undefined) {
  const open = useActiveParCycle(workEmail);
  const openCycles = open.data ?? [];
  const hasOpen = openCycles.length > 0;
  // Fire the CLOSED lookup only after OPEN resolves with an empty array.
  const closed = useClosedParCycles(
    workEmail,
    !open.isLoading && !open.isError && !hasOpen,
  );
  const cycle = hasOpen ? pickMostRecent(openCycles) : pickMostRecent(closed.data ?? []);
  return {
    cycle,
    isActive: hasOpen,
    isLoading: open.isLoading || (!hasOpen && closed.isLoading),
    isError: open.isError || (!hasOpen && closed.isError),
    error: open.error ?? closed.error,
  };
}

// Sort by parCycleStartDate DESC so we pick the freshest cycle regardless
// of the backend's default ordering.
function pickMostRecent(cycles: ParCycle[]): ParCycle | undefined {
  if (!cycles.length) return undefined;
  return [...cycles].sort((a, b) =>
    (b.parCycleStartDate ?? "").localeCompare(a.parCycleStartDate ?? ""),
  )[0];
}

export function isParBackendConfigured(): boolean {
  return Boolean(parBackendUrl);
}
