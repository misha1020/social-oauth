export type YandexAuthSuccess = {
  cancelled?: false;
  accessToken: string;
  expiresIn: number;
};

export type YandexAuthCancelled = {
  cancelled: true;
};

export type YandexAuthResult = YandexAuthSuccess | YandexAuthCancelled;
