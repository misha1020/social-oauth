const path = require('path');
const fs = require('fs');
const { getUsers, findById, findByProvider, createUser } = require('../../src/services/users');

const TEST_FILE = path.join(__dirname, '../../data/users.test.json');

beforeEach(() => {
  fs.writeFileSync(TEST_FILE, '[]');
});

afterAll(() => {
  if (fs.existsSync(TEST_FILE)) fs.unlinkSync(TEST_FILE);
});

describe('users service (generic provider schema)', () => {
  test('getUsers returns empty array from empty file', () => {
    expect(getUsers(TEST_FILE)).toEqual([]);
  });

  test('createUser adds a VK user', () => {
    const user = createUser(
      { provider: 'vk', providerId: '12345', firstName: 'Ivan', lastName: 'Petrov' },
      TEST_FILE
    );
    expect(user).toMatchObject({
      provider: 'vk',
      providerId: '12345',
      firstName: 'Ivan',
      lastName: 'Petrov',
    });
    expect(user.id).toBeDefined();
    expect(user.createdAt).toBeDefined();
  });

  test('createUser adds a Yandex user with email and avatarId', () => {
    const user = createUser(
      {
        provider: 'yandex',
        providerId: '1000034426',
        firstName: 'Anna',
        lastName: 'Smirnova',
        email: 'anna@yandex.ru',
        avatarId: '131652443',
      },
      TEST_FILE
    );
    expect(user).toMatchObject({
      provider: 'yandex',
      providerId: '1000034426',
      email: 'anna@yandex.ru',
      avatarId: '131652443',
    });
  });

  test('findByProvider returns existing user', () => {
    createUser({ provider: 'vk', providerId: '99999', firstName: 'Anna', lastName: 'S' }, TEST_FILE);
    const found = findByProvider('vk', '99999', TEST_FILE);
    expect(found).toMatchObject({ provider: 'vk', providerId: '99999' });
  });

  test('findByProvider returns null for unknown', () => {
    expect(findByProvider('vk', '11111', TEST_FILE)).toBeNull();
  });

  test('findByProvider differentiates between providers with same providerId', () => {
    createUser({ provider: 'vk', providerId: '42', firstName: 'A', lastName: 'B' }, TEST_FILE);
    createUser({ provider: 'yandex', providerId: '42', firstName: 'C', lastName: 'D' }, TEST_FILE);
    const vk = findByProvider('vk', '42', TEST_FILE);
    const yandex = findByProvider('yandex', '42', TEST_FILE);
    expect(vk.firstName).toBe('A');
    expect(yandex.firstName).toBe('C');
    expect(vk.id).not.toBe(yandex.id);
  });

  test('createUser is idempotent — returns existing on duplicate provider+providerId', () => {
    const first = createUser({ provider: 'vk', providerId: '12345', firstName: 'I', lastName: 'P' }, TEST_FILE);
    const second = createUser({ provider: 'vk', providerId: '12345', firstName: 'I', lastName: 'P' }, TEST_FILE);
    expect(second.id).toBe(first.id);
    expect(getUsers(TEST_FILE)).toHaveLength(1);
  });

  test('findById returns user by uuid', () => {
    const created = createUser({ provider: 'vk', providerId: '77777', firstName: 'O', lastName: 'I' }, TEST_FILE);
    expect(findById(created.id, TEST_FILE)).toMatchObject({ providerId: '77777' });
  });
});
