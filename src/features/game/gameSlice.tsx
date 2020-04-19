import { createSlice, PayloadAction } from "@reduxjs/toolkit";
import * as PusherTypes from "pusher-js";

import { AppThunk, RootState } from "../../app/store";

import {
  dealCards,
  Fold,
  Move,
  isAllSameFigure,
  getFigure,
} from "../../services/cardsUtils";

import { setPastGame, selectCurrentGameId } from "../room/roomSlice";

interface GameState {
  gameId: string | null;
  status: "starting" | "running" | "finished" | undefined;
  playersHands: { [playerId: string]: number[] };
  currentPlayer: string | null;
  currentFold: Fold | null;
  finishedPlayers: string[] | null;
  playerIds: string[] | null;
  disqualifiedPlayers: string[] | null;
  isRevolution: boolean;
}
const initialState: GameState = {
  gameId: null,
  status: undefined,
  playersHands: {},
  currentPlayer: null,
  currentFold: null,
  finishedPlayers: null,
  playerIds: null,
  disqualifiedPlayers: null,
  isRevolution: false,
};

let getChannel: () => PusherTypes.PresenceChannel | null = () => null;
let setChannel: (
  channel: PusherTypes.PresenceChannel | null
) => void = () => {};

export const gameSlice = createSlice({
  name: "game",
  initialState,
  reducers: {
    reset: (state) => initialState,
    setStatus: (
      state,
      action: PayloadAction<"starting" | "running" | "finished" | undefined>
    ) => {
      state.status = action.payload;
      if (action.payload === "starting") {
        state.finishedPlayers = [];
        state.disqualifiedPlayers = [];
      }
    },
    setPlayerIds: (state, action: PayloadAction<string[]>) => {
      state.playerIds = action.payload;
    },
    setPlayersHands: (
      state,
      action: PayloadAction<{ [playerId: string]: number[] }>
    ) => {
      state.playersHands = action.payload;
    },
    setCurrentPlayer: (state, action: PayloadAction<string>) => {
      state.currentPlayer = action.payload;
    },
    setNewFold: (state, action: PayloadAction<number[]>) => {
      state.currentFold = {
        moves: [],
        passedPlayers: [],
        cardsPerPlay: action.payload.length,
        closed: false,
      };
    },
    setFoldClosed: (state) => {
      if (state.currentFold) state.currentFold.closed = true;
    },
    setEndFold: (state) => {
      state.currentFold = null;
    },
    setPlayedMove: (state, action: PayloadAction<Move>) => {
      const {
        payload: { playerId, cards },
      } = action;
      state.playersHands[playerId] = state.playersHands[playerId].filter(
        (card) => !cards.includes(card)
      );
      if (state.playersHands[playerId].length === 0) {
        state.finishedPlayers?.push(playerId);
      }
      if (state.currentFold) {
        state.currentFold.moves.push(action.payload);
      }
    },
    setDisqualifiedPlayer: (state, action: PayloadAction<string>) => {
      state.disqualifiedPlayers?.push(action.payload);
    },
    setPlayerPassed: (state, action: PayloadAction<string>) => {
      state.currentFold?.passedPlayers.push(action.payload);
    },
    setPlayersPassed: (state, action: PayloadAction<string[]>) => {
      if (state.currentFold) state.currentFold.passedPlayers = action.payload;
    },
    setToggleRevolution: (state) => {
      state.isRevolution = !state.isRevolution;
    },
  },
});

export const {
  setStatus,
  setPlayerIds,
  setPlayersHands,
  setCurrentPlayer,
  setNewFold,
  setFoldClosed,
  setEndFold,
  setPlayedMove,
  setPlayerPassed,
  setPlayersPassed,
  reset,
  setDisqualifiedPlayer,
  setToggleRevolution,
} = gameSlice.actions;

export const initializeGame = (
  isHost: boolean,
  playerIds: string[]
): AppThunk => (dispatch, getState) => {
  const channel: PusherTypes.PresenceChannel | null = getChannel();
  if (!channel) throw new Error("Channel not initialized");

  console.log("setting up game");
  dispatch(setStatus("starting"));

  dispatch(setPlayerIds(playerIds));

  // ask server to deal cards if Host
  if (isHost) {
    console.log("Deal cards");

    const hands = dealCards(playerIds);
    const cardEchangeOrders = null; // TODO select card exchange orders
    const pusherId = selectPusherId(getState());
    console.log("dealing cards as ", pusherId);
    if (pusherId) {
      setTimeout(() => {
        channel.trigger("client-game-cards-dealt", hands);
        dispatch(setPlayersHands(hands));
        dispatch(setCurrentPlayer(pusherId));
        if (cardEchangeOrders) {
          channel.trigger(
            "client-game-cards-to-be-exchanged",
            cardEchangeOrders
          );
          //dispatch corresponding actions
        } else {
          channel.trigger("client-game-started", {});
        }
      }, 1000);
    }
  } else {
    // set up event sto watch
    channel.bind(
      "client-game-cards-dealt",
      (
        data: { [playerId: string]: number[] },
        metadata: { user_id: string }
      ) => {
        console.log("Received cards", data);
        dispatch(setPlayersHands(data));
        dispatch(setCurrentPlayer(metadata.user_id));
      }
    );

    channel.bind(
      "client-game-cards-to-be-exchanged",
      (data: {}, metadata: { user_id: string }) => {
        console.log("cards exchange starting", data);
        // TODO, if current player is one of them, do exchange
      }
    );

    channel.bind(
      "client-game-cards-exchanged",
      (data: {}, metadata: { user_id: string }) => {
        console.log("cards exchange done", data);
        // TODO update Card Exchange orders.
      }
    );

    channel.bind(
      "client-game-started",
      (data: {}, metadata: { user_id: string }) => {
        console.log("cards exchange done", data);
        // TODO update hands based on what was exchanged for every players.
        // TODO set status running
      }
    );
  }

  // set up event sto watch
  channel.bind(
    "client-game-cards-played",
    (data: any, metadata: { user_id: string }) => {
      dispatch(setPlayedMove({ playerId: metadata.user_id, cards: data }));
      dispatch(checkClosedFold());
      console.log("playing cards", data);
      if (data.length === 4) dispatch(setToggleRevolution());
      const nextPLayer = selectNextPlayer(getState());
      if (nextPLayer) {
        dispatch(setCurrentPlayer(nextPLayer));
      }
    }
  );

  channel.bind(
    "client-game-player-passed",
    (data: any, metadata: { user_id: string }) => {
      console.log("player passed", metadata.user_id);
      dispatch(setPlayerPassed(metadata.user_id));
      dispatch(checkClosedFold());
      const nextPLayer = selectNextPlayer(getState());
      if (nextPLayer) {
        dispatch(setCurrentPlayer(nextPLayer));
      }
    }
  );

  channel.bind(
    "client-game-fold-started",
    (data: number[], metadata: { user_id: string }) => {
      console.log("fold started", metadata.user_id);
      dispatch(setNewFold(data));

      const currentPlayer = selectCurrentPlayer(getState());
      if (!currentPlayer) throw "No current PLayer";

      if (data.length === 4) dispatch(setToggleRevolution());
      dispatch(setPlayedMove({ playerId: currentPlayer, cards: data }));
      dispatch(checkClosedFold());

      const nextPLayer = selectNextPlayer(getState());
      if (nextPLayer) {
        dispatch(setCurrentPlayer(nextPLayer));
      }
    }
  );
};

export const playCards = (cards: number[]): AppThunk => (
  dispatch,
  getState
) => {
  const channel: PusherTypes.PresenceChannel | null = getChannel();
  if (!channel) throw new Error("Channel not initialized");

  channel.trigger("client-game-cards-played", cards);
  console.log("playing cards");

  const currentPlayer = selectCurrentPlayer(getState());
  if (!currentPlayer) throw "No current PLayer";

  console.log("playing cards", cards);
  if (cards.length === 4) dispatch(setToggleRevolution());
  dispatch(setPlayedMove({ playerId: currentPlayer, cards }));
  dispatch(checkClosedFold());

  const nextPLayer = selectNextPlayer(getState());
  if (nextPLayer) {
    dispatch(setCurrentPlayer(nextPLayer));
  }
};

export const pass = (): AppThunk => (dispatch, getState) => {
  const channel: PusherTypes.PresenceChannel | null = getChannel();
  if (!channel) throw new Error("Channel not initialized");

  channel.trigger("client-game-player-passed", {});

  const currentPlayer = selectCurrentPlayer(getState());
  if (!currentPlayer) throw "No current PLayer";

  dispatch(setPlayerPassed(currentPlayer));
  dispatch(checkClosedFold());

  const nextPLayer = selectNextPlayer(getState());
  if (nextPLayer) {
    dispatch(setCurrentPlayer(nextPLayer));
  }
};

export const startNewFold = (cards: number[]): AppThunk => (
  dispatch,
  getState
) => {
  const channel: PusherTypes.PresenceChannel | null = getChannel();
  if (!channel) throw new Error("Channel not initialized");

  channel.trigger("client-game-fold-started", cards);

  dispatch(setNewFold(cards));

  const currentPlayer = selectCurrentPlayer(getState());
  if (!currentPlayer) throw "No current PLayer";

  if (cards.length === 4) dispatch(setToggleRevolution());
  dispatch(setPlayedMove({ playerId: currentPlayer, cards }));

  dispatch(checkClosedFold());

  const nextPLayer = selectNextPlayer(getState());
  if (nextPLayer) {
    dispatch(setCurrentPlayer(nextPLayer));
  }
};

export const archiveCurrentGame = (): AppThunk => (dispatch, getState) => {
  const currentGame = selectCurrentGameId(getState());
  const playerIds = selectPlayerIds(getState());
  const finishedPlayers = selectFinishedPlayers(getState());
  const disqualifiedPlayers = selectDisqualifiedPlauers(getState());

  if (!currentGame || !playerIds || !finishedPlayers || !disqualifiedPlayers)
    throw new Error("how did we get there ?");

  const lastPlayerNotFinished = playerIds.find(
    (player) => !finishedPlayers.includes(player)
  );
  if (!lastPlayerNotFinished) throw new Error("how did we get there ?");

  const finishedNotDisqualified = finishedPlayers.filter(
    (player) => !disqualifiedPlayers.includes(player)
  );
  const finishOrder = [
    ...finishedNotDisqualified,
    lastPlayerNotFinished,
    ...disqualifiedPlayers.slice().reverse(),
  ];

  if (playerIds.length !== finishOrder.length)
    throw new Error("WE FORGOT TO FLAG SOMEONE AS FINISHED");

  dispatch(setPastGame({ id: currentGame, playerIds, finishOrder }));

  const channel: PusherTypes.PresenceChannel | null = getChannel();
  if (!channel) throw new Error("Channel not initialized");
  [
    "client-game-cards-dealt",
    "client-game-cards-to-be-exchanged",
    "client-game-started",
    "client-game-cards-exchanged",
    "client-game-cards-played",
    "client-game-player-passed",
    "client-game-fold-started",
  ].map((message) => channel.unbind(message));
};

export const checkClosedFold = (): AppThunk => (dispatch, getState) => {
  const fold = selectCurrentFold(getState());
  const currentPlayer = selectCurrentPlayer(getState());
  const playerHands = selectAdversaryHandSize;
  if (fold && currentPlayer) {
    console.log("Checking if fold is closed", fold.moves.slice(-1));
    const playerIds = selectPlayerIds(getState());
    if (!playerIds) return false;

    // Closed if all those that have cards left in their hands have passed.
    if (
      !playerIds.some((playerId) => {
        const handSize = selectAdversaryHandSize(playerId)(getState());
        return (
          handSize && handSize > 0 && !fold.passedPlayers.includes(playerId)
        );
      })
    ) {
      dispatch(setFoldClosed());
      dispatch(setPlayersPassed(playerIds));
      dispatch(
        setCurrentPlayer(
          fold.moves.filter((move) => move.cards.length > 0).slice(-1)[0]
            .playerId
        )
      );
    } else if (
      fold.moves.length !== 0 &&
      fold.moves.slice(-1)[0].cards[0] % 13 === 12
    ) {
      dispatch(setPlayersPassed(playerIds));
      dispatch(setFoldClosed());
      const handsize = selectAdversaryHandSize(
        fold.moves.slice(-1)[0].playerId
      )(getState());
      console.log("Did they finish with a 2 ???", handsize);

      if (handsize !== undefined && handsize === 0) {
        dispatch(setDisqualifiedPlayer(fold.moves.slice(-1)[0].playerId));
      }
      dispatch(
        setCurrentPlayer(
          fold.moves.filter((move) => move.cards.length > 0).slice(-1)[0]
            .playerId
        )
      );
    } else if (fold.cardsPerPlay !== 4) {
      const playedCardsInFold = fold.moves.map((move) => move.cards).flat();
      if (
        playedCardsInFold.length >= 4 &&
        isAllSameFigure(playedCardsInFold.slice(-4))
      ) {
        dispatch(setFoldClosed());
        dispatch(setPlayersPassed(playerIds));
        dispatch(
          setCurrentPlayer(
            fold.moves.filter((move) => move.cards.length > 0).slice(-1)[0]
              .playerId
          )
        );
      }
    }
  }
};

export const selectGameId = (state: RootState) => state.game.gameId;
export const selectStatus = (state: RootState) => state.game.status;
export const selectPlayerIds = (state: RootState) => state.game.playerIds;

export const selectPlayerHand = (state: RootState) =>
  state.room.pusherId ? state.game.playersHands[state.room.pusherId] : null;

export const selectIsPlayerTurn = (state: RootState) =>
  state.game.currentPlayer === state.room.pusherId;
export const selectHasPlayerPassed = (state: RootState) =>
  state.room.pusherId &&
  state.game.currentFold?.passedPlayers.includes(state.room.pusherId);

export const selectCurrentPlayer = (state: RootState) =>
  state.game.currentPlayer;

export const selectPusherId = (state: RootState) => state.room.pusherId;

export const selectNextPlayer = (state: RootState) => {
  if (!state.game.playerIds || !state.game.currentPlayer) return undefined;
  const currentPLayerIndex = state.game.playerIds.indexOf(
    state.game.currentPlayer
  );
  if (currentPLayerIndex === -1) throw new Error("NO CURRENT PLAYER");

  console.log("CURRENT FOLD", state.game.currentFold);
  if (
    state.game.currentFold?.closed &&
    state.game.playersHands[state.game.currentPlayer].length === 0
  ) {
    for (let i = 0; i < state.game.playerIds.length; i++) {
      const consideredPlayerIndex =
        (currentPLayerIndex + 1 + i) % state.game.playerIds.length;
      const consideredPlayerId = state.game.playerIds[consideredPlayerIndex];
      console.log(
        currentPLayerIndex,
        consideredPlayerIndex,
        consideredPlayerId
      );
      if (state.game.playersHands[consideredPlayerId].length > 0) {
        // has still cards in hand
        return consideredPlayerId;
      }
    }
  } else {
    for (let i = 0; i < state.game.playerIds.length; i++) {
      const consideredPlayerIndex =
        (currentPLayerIndex + 1 + i) % state.game.playerIds.length;
      const consideredPlayerId = state.game.playerIds[consideredPlayerIndex];
      console.log(
        currentPLayerIndex,
        consideredPlayerIndex,
        consideredPlayerId
      );
      if (
        state.game.playersHands[consideredPlayerId].length > 0 &&
        !state.game.currentFold?.passedPlayers.includes(consideredPlayerId)
      ) {
        // has still cards in hand and has not passed
        return consideredPlayerId;
      }
    }
  }

  // no player available, return null
  return null;
};

export const selectAdversaries = (state: RootState) => {
  if (!state.game.playerIds || !state.room.pusherId) return undefined;
  const playerIndex = state.game.playerIds.indexOf(state.room.pusherId);
  if (playerIndex === -1) throw new Error("NO PLAYER");

  let adversaries: string[] = [];

  for (let i = 1; i < state.game.playerIds.length; i++) {
    const consideredPlayerIndex =
      (playerIndex + i) % state.game.playerIds.length;
    adversaries.push(state.game.playerIds[consideredPlayerIndex]);
  }

  return adversaries;
};

export const selectAdversaryHandSize = (playerId: string) => (
  state: RootState
) => {
  const hand = state.game.playersHands[playerId];
  if (hand) return hand.length;
  return undefined;
};

export const selectCurrentFold = (state: RootState) => state.game.currentFold;

export default (gc: any, sc: any) => {
  getChannel = gc;
  setChannel = sc;
  return gameSlice.reducer;
};

export const selectIsFoldClosed = (state: RootState) =>
  state.game?.currentFold?.closed;

export const selectFinishedPlayers = (state: RootState) =>
  state.game?.finishedPlayers;

export const selectPassedPlayers = (state: RootState) =>
  state.game?.currentFold?.passedPlayers;

export const selectIsGameFinished = (state: RootState) =>
  state.game.playerIds &&
  state.game.finishedPlayers &&
  state.game.finishedPlayers?.length === state.game.playerIds?.length - 1;

export const selectDisqualifiedPlauers = (state: RootState) =>
  state.game.disqualifiedPlayers;

export const selectIsSameOrNothingPlay = (state: RootState) => {
  console.log("Recomputing is SAme or Nothing", state.game.currentFold);
  return (
    state.game.currentFold &&
    state.game.currentFold.moves.length >= 2 &&
    new Set(
      state.game.currentFold.moves
        .filter((move) => move.cards.length !== 0)
        .slice(-2)
        .map((move) => getFigure(move.cards[0]))
    ).size === 1 &&
    state.game.currentFold.moves.slice(-1)[0].cards.length !== 0
  );
};

export const selectIsRevolution = (state: RootState) => state.game.isRevolution;
