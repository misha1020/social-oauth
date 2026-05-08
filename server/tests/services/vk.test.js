const { exchangeCode, fetchUserProfile } = require('../../src/services/vk');

global.fetch = jest.fn();

beforeEach(() => {
  fetch.mockReset();
});

describe('vk service', () => {
  describe('exchangeCode', () => {
    test('POSTs to id.vk.ru/oauth2/auth and returns tokens', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          access_token: 'vk-access-token',
          user_id: 12345,
          id_token: 'some-id-token',
        }),
      });

      const result = await exchangeCode({
        code: 'auth-code',
        codeVerifier: 'verifier',
        deviceId: 'device-123',
        redirectUri: 'vk54501952://vk.ru/blank.html',
        clientId: '54501952',
      });

      expect(result).toEqual({
        accessToken: 'vk-access-token',
        userId: 12345,
        idToken: 'some-id-token',
      });
      expect(fetch).toHaveBeenCalledWith(
        'https://id.vk.ru/oauth2/auth',
        expect.objectContaining({ method: 'POST' })
      );
    });

    test('throws on VK error response', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          error: 'invalid_grant',
          error_description: 'Code expired',
        }),
      });

      await expect(
        exchangeCode({
          code: 'bad-code',
          codeVerifier: 'verifier',
          deviceId: 'device-123',
          redirectUri: 'vk54501952://vk.ru/blank.html',
          clientId: '54501952',
        })
      ).rejects.toThrow('Code expired');
    });
  });

  describe('fetchUserProfile', () => {
    test('POSTs to id.vk.ru/oauth2/user_info and returns parsed profile', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          user: {
            user_id: '12345',
            first_name: 'Ivan',
            last_name: 'Petrov',
          },
        }),
      });

      const profile = await fetchUserProfile('vk-access-token', '54501952', 'device-123');
      expect(profile).toEqual({
        provider: 'vk',
        providerId: '12345',
        firstName: 'Ivan',
        lastName: 'Petrov',
      });
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('https://id.vk.ru/oauth2/user_info'),
        expect.objectContaining({ method: 'POST' })
      );
    });
  });
});
