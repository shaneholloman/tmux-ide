/* Copyright (c) 2026 wavyrai. SPDX-License-Identifier: ISC */
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include "tmux-ide-journal.h"
int main(void) {
 struct ti_ring *ring = calloc(1, sizeof *ring);
 struct ti_record record = {0};
 uint64_t i;
 assert(ring);
 assert(ti_oldest(ring) == 1 && ti_at(ring,0) == NULL && ti_at(ring,1) == NULL);
 for(i=1;i<=TI_CAPACITY*3+17;i++) {
  record.command_id=i; record.issuer_id=UINT64_MAX; record.count=i*7;
  assert(ti_append(ring,&record));
  assert(ti_at(ring,i)->command_id == i);
  assert(ti_at(ring,i)->issuer_id == UINT64_MAX);
  if(i>TI_CAPACITY) assert(ti_at(ring,i-TI_CAPACITY) == NULL);
 }
 assert(ti_oldest(ring) == ring->newest - TI_CAPACITY + 1);
 for(i=ti_oldest(ring);i<=ring->newest;i++) assert(ti_at(ring,i)->sequence == i);
 ring->newest=UINT64_MAX-1;
 assert(ti_append(ring,&record));
 assert(ti_at(ring,UINT64_MAX)->sequence==UINT64_MAX);
 assert(!ti_append(ring,&record));
 assert(ring->newest==UINT64_MAX);
 memset(ring,0,sizeof *ring);
 assert(ti_append(ring,&record) && ring->newest==1);
 free(ring);
 puts("journal fixed ring: overflow, bounds, uint64 exhaustion and reset passed");
 return 0;
}
