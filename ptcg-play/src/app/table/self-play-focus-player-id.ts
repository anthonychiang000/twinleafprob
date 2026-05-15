import { State } from 'ptcg-server';

export function selfPlayFocusPlayerId(state: State): number {
  const pending = state.prompts.filter(p => p.result === undefined);
  if (pending.length > 0) {
    return pending[0].playerId;
  }
  const activePlayer = state.players[state.activePlayer];
  if (activePlayer) {
    return activePlayer.id;
  }
  return state.players[0] ? state.players[0].id : 0;
}
