import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsername, usernameError, passwordError, serverPassword, AVATARS, avatarAt, usernameToEmail, listTime, dayLabel,
  lastSeenText, fitSize, withDaySeparators, mergeMessages, avatarFor, friendlyError,
} from '../src/util.js';

const now = new Date(2026, 9, 29, 18, 30); // Perşembe

test('kullanıcı adı: Türkçe harf ve boşluk sadeleşir, kurallar', () => {
  assert.equal(normalizeUsername('  Ümit Çağrı '), 'umit_cagri');
  assert.equal(normalizeUsername('İSMAİL'), 'ismail');
  assert.equal(usernameError('ab'), 'Kullanıcı adı en az 3 harf olmalı');
  assert.equal(usernameError('ali-veli'), 'Yalnızca harf, rakam ve _ kullanılabilir');
  assert.equal(usernameError('ali_2'), null);
  assert.equal(passwordError(''), 'Şifre gerekli');
  assert.equal(passwordError('1'), null);
  assert.equal(passwordError('ş ğ*?.'), null);
  assert.equal(passwordError('12345678'), null);
  assert.equal(passwordError('123456789'), 'Şifre en fazla 8 karakter olabilir');
  assert.ok(serverPassword('1').length >= 6);
  assert.equal(usernameToEmail('ali'), 'ali@mesaj-app.com');
});

test('zaman yazıları', () => {
  assert.equal(listTime(new Date(2026, 9, 29, 9, 5).toISOString(), now), '09:05');
  assert.equal(listTime(new Date(2026, 9, 28, 23, 0).toISOString(), now), 'Dün');
  assert.equal(listTime(new Date(2026, 9, 26, 12, 0).toISOString(), now), 'Pazartesi');
  assert.equal(listTime(new Date(2026, 8, 1, 12, 0).toISOString(), now), '01.09.2026');
  assert.equal(dayLabel(new Date(2026, 9, 29, 1).toISOString(), now), 'Bugün');
  assert.equal(dayLabel(new Date(2026, 2, 3).toISOString(), now), '3 Mart');
  assert.equal(dayLabel(new Date(2025, 2, 3).toISOString(), now), '3 Mart 2025');
  assert.equal(lastSeenText(true, null, now), 'çevrimiçi');
  assert.equal(lastSeenText(false, new Date(2026, 9, 29, 14, 7).toISOString(), now), 'son görülme bugün 14:07');
  assert.equal(lastSeenText(false, new Date(2026, 9, 28, 8, 0).toISOString(), now), 'son görülme dün 08:00');
});

test('resim boyutu küçülür, büyümez', () => {
  assert.deepEqual(fitSize(4000, 3000, 1600), { w: 1600, h: 1200 });
  assert.deepEqual(fitSize(800, 600, 1600), { w: 800, h: 600 });
  assert.deepEqual(fitSize(1000, 3000, 1600), { w: 533, h: 1600 });
});

test('mesajlar: gün ayracı ve birleştirme', () => {
  const a = { id: 1, created_at: new Date(2026, 9, 28, 10).toISOString(), body: 'a' };
  const b = { id: 2, created_at: new Date(2026, 9, 29, 10).toISOString(), body: 'b' };
  const c = { id: 3, created_at: new Date(2026, 9, 29, 11).toISOString(), body: 'c' };
  const rows = withDaySeparators([a, b, c], now);
  assert.deepEqual(rows.map((r) => (r.type === 'day' ? r.label : r.m.id)), ['Dün', 1, 'Bugün', 2, 3]);
  const merged = mergeMessages([b, a], [{ ...b, read_at: 'x' }, c]);
  assert.deepEqual(merged.map((m) => m.id), [1, 2, 3]);
  assert.equal(merged[1].read_at, 'x');
});

test('avatar ve hata metinleri', () => {
  const x = avatarFor('ışık');
  assert.equal(x.initial, 'I');
  assert.equal(avatarFor('ali').color, avatarFor('ali').color);
  assert.equal(friendlyError(new Error('Invalid login credentials')), 'Kullanıcı adı ya da şifre yanlış');
  assert.equal(friendlyError(new Error('User already registered')), 'Bu kullanıcı adı alınmış');
  assert.equal(friendlyError(new TypeError('Failed to fetch')), 'İnternet bağlantısı yok gibi görünüyor');
});

test('20 farklı hayvan profil resmi', () => {
  assert.equal(AVATARS.length, 20);
  assert.equal(new Set(AVATARS.map((a) => a.e)).size, 20);
  assert.equal(avatarAt(99).e, AVATARS[19].e);
  assert.equal(avatarAt(-3).e, AVATARS[0].e);
});
