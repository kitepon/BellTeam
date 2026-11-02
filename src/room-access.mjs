export function requireRoomMember(rooms, id, from) {
  const room = requireRoom(rooms, id)
  if (!room.memberIds.includes(from)) throw new Error(`ROOM_MEMBER_REQUIRED: ${id}`)
  return room
}

export function requireRoom(rooms, id) {
  const room = rooms.get(id)
  if (!room) throw new Error(`ROOM_NOT_FOUND: ${id}`)
  return room
}

export function requireRepresentative(rooms, id, from) {
  const room = requireRoomMember(rooms, id, from)
  if (room.representativeId !== from) throw new Error(`ROOM_REPRESENTATIVE_REQUIRED: ${id}`)
  return room
}
