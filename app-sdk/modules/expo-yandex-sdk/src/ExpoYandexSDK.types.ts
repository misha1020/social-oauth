export type YandexAuthSuccess = {
  cancelled?: false;
  accessToken: string;
  expiresIn: number;
  // Yandex-signed JWT, fetched natively via the SDK's getJwt() (Approach A).
  jwt: string;
};

export type YandexAuthCancelled = {
  cancelled: true;
};

export type YandexAuthResult = YandexAuthSuccess | YandexAuthCancelled;
