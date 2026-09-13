"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  disconnectPilotRealtimeForSignedOut,
  getPilotRealtimeWsUrl,
  PilotRealtimeClient,
  type PilotRealtimeStateSnapshot,
} from "@/lib/realtime/pilot-realtime-client";
import type { PilotRealtimeClientMessage } from "@/lib/realtime/session-protocol";
import { supabase } from "@/lib/supabase";

const INITIAL_SNAPSHOT: PilotRealtimeStateSnapshot = {
  state: "idle",
  sessionId: null,
  error: null,
  reconnectAttempt: 0,
};

type PilotRealtimeAuthClient = Pick<PilotRealtimeClient, "disconnect" | "reauthenticate">;
type PilotRuntimeEvent = Extract<
  PilotRealtimeClientMessage,
  {
    type:
      | "transcript.partial"
      | "transcript.final"
      | "question.detected"
      | "screen.context"
      | "session.metrics";
  }
>;
type PilotRealtimeAuthSession = {
  access_token?: string | null;
} | null;

export function handlePilotRealtimeAuthStateChange(
  client: PilotRealtimeAuthClient,
  event: string,
  session: PilotRealtimeAuthSession
): void {
  if (event === "SIGNED_OUT") {
    client.disconnect("Supabase signed out");
    return;
  }

  if (event !== "TOKEN_REFRESHED" && event !== "SIGNED_IN") {
    return;
  }
  if (!session?.access_token) {
    return;
  }
  client.reauthenticate();
}

async function getCurrentSupabaseAccessToken(): Promise<string | null> {
  if (supabase === null) {
    return null;
  }

  const { data, error } = await supabase.auth.getSession();
  if (error !== null) {
    return null;
  }

  return data.session?.access_token ?? null;
}

export function usePilotRealtimeConnection() {
  const clientRef = useRef<PilotRealtimeClient | null>(null);
  const mountedRef = useRef(false);
  const [snapshot, setSnapshot] = useState<PilotRealtimeStateSnapshot>(INITIAL_SNAPSHOT);

  useEffect(() => {
    mountedRef.current = true;
    const client = new PilotRealtimeClient({
      authProvider: {
        getAccessToken: getCurrentSupabaseAccessToken,
      },
      url: getPilotRealtimeWsUrl(),
      onStateChange: (nextSnapshot) => {
        if (mountedRef.current) {
          setSnapshot(nextSnapshot);
        }
      },
    });
    clientRef.current = client;
    client.connect();

    const authSubscription =
      supabase?.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
          disconnectPilotRealtimeForSignedOut(client);
          return;
        }
        handlePilotRealtimeAuthStateChange(client, event, session);
      }).data.subscription ?? null;

    return () => {
      mountedRef.current = false;
      authSubscription?.unsubscribe();
      client.cleanup();
      if (clientRef.current === client) {
        clientRef.current = null;
      }
    };
  }, []);

  const disconnect = useCallback(() => {
    clientRef.current?.disconnect("Manual disconnect");
  }, []);

  const connect = useCallback(() => {
    clientRef.current?.connect();
  }, []);

  const endSession = useCallback(() => {
    clientRef.current?.endSession("User ended session");
  }, []);

  const ping = useCallback(() => {
    clientRef.current?.ping();
  }, []);

  const sendRuntimeEvent = useCallback((message: PilotRuntimeEvent) => {
    return clientRef.current?.sendRuntimeEvent(message) ?? false;
  }, []);

  return {
    ...snapshot,
    connect,
    disconnect,
    endSession,
    ping,
    sendRuntimeEvent,
  };
}
