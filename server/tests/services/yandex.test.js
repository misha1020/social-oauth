const { fetchUserProfile } = require('../../src/services/yandex');

global.fetch = jest.fn();

beforeEach(() => {
  fetch.mockReset();
});

describe('yandex service', () => {
  describe('fetchUserProfile', () => {
    test('GETs login.yandex.ru/info with OAuth header and returns mapped profile', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '1000034426',
          login: 'ivan',
          default_email: 'ivan@yandex.ru',
          default_avatar_id: '131652443',
          first_name: 'Ivan',
          last_name: 'Petrov',
          display_name: 'ivan',
        }),
      });

      const result = await fetchUserProfile('access-token-xyz');

      expect(fetch).toHaveBeenCalledWith(
        'https://login.yandex.ru/info?format=json',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'OAuth access-token-xyz',
          }),
        })
      );
      expect(result).toEqual({
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Ivan',
        lastName: 'Petrov',
        email: 'ivan@yandex.ru',
        avatarId: '131652443',
      });
    });

    test('omits email/avatarId when not granted in scopes', async () => {
      fetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          id: '1000034426',
          login: 'ivan',
          first_name: 'Ivan',
          last_name: 'Petrov',
        }),
      });

      const result = await fetchUserProfile('token');
      expect(result).toMatchObject({
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Ivan',
        lastName: 'Petrov',
      });
      expect(result.email).toBeUndefined();
      expect(result.avatarId).toBeUndefined();
    });

    test('throws yandex_token_invalid on 401 response', async () => {
      fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'invalid_token' }),
      });

      await expect(fetchUserProfile('bad-token')).rejects.toThrow(/yandex_token_invalid/);
    });

    test('throws yandex_unreachable on network error', async () => {
      fetch.mockRejectedValueOnce(new Error('ENOTFOUND'));
      await expect(fetchUserProfile('token')).rejects.toThrow(/yandex_unreachable/);
    });
  });
});
